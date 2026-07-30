import type { Message, ToolDefinition } from '@trustos/ai-sdk';

/**
 * Token counting.
 *
 * Every model tokenises differently, and the only exact count comes from the provider after the
 * call. This produces an **estimate**, and everything about the design follows from being honest
 * about that:
 *
 *   * `estimate` is in the name of the function and `estimated: true` is in the result. A cost
 *     report that cannot distinguish an estimate from a measurement is a report nobody can
 *     reconcile against an invoice.
 *   * The estimate is deliberately **conservative** — it rounds up. An estimate used to check
 *     "will this fit in the context window" must not say yes when the answer is no: the cost of
 *     over-estimating is a slightly smaller conversation, and the cost of under-estimating is a
 *     failed request after the tokens have already been billed.
 *   * A `Tokenizer` port exists so a deployment that cares can plug in a real one. The framework
 *     ships no tokeniser library, because `tiktoken` is a large native dependency and most
 *     applications do not need exactness.
 *
 * The heuristic is characters ÷ 3.6 for English-like text, with adjustments. Not ÷4, which is the
 * number everybody quotes: ÷4 is the *average* for English prose, and averages under-count code,
 * JSON and non-Latin scripts — all three of which are common in prompts.
 */

export interface Tokenizer {
  /** The model family this counts for. */
  readonly name: string;
  count(text: string): number;
}

/**
 * The default estimator.
 *
 * Character-based with three adjustments, each for a case where the naive ratio is badly wrong:
 *
 *   * **Non-Latin scripts** — Khmer, Chinese, Japanese, Korean, Arabic, Thai. These tokenise at
 *     roughly one token per character or worse, so a ÷4 estimate under-counts by 3–4×. In a
 *     Cambodian deployment that is not an edge case.
 *   * **Whitespace runs** — indented JSON and code are largely whitespace, which compresses well.
 *   * **Long unbroken tokens** — base64, hashes, identifiers. These split badly and cost more
 *     than their length suggests.
 */
export class HeuristicTokenizer implements Tokenizer {
  readonly name = 'heuristic';

  count(text: string): number {
    if (text.length === 0) return 0;

    let latin = 0;
    let wide = 0;
    let whitespace = 0;

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;

      if (char === ' ' || char === '\n' || char === '\t' || char === '\r') {
        whitespace += 1;
        continue;
      }

      // CJK, Khmer, Thai, Arabic, Hebrew, Devanagari and the rest of the non-Latin ranges. One
      // token per character is closer to the truth than one per four.
      if (code > 0x0590) wide += 1;
      else latin += 1;
    }

    // Whitespace at roughly a sixth of a token: a run of indentation is usually one token.
    const estimate = latin / 3.6 + wide * 1.1 + whitespace / 6;

    // Rounded up, always. See the header: an under-estimate turns into a failed request after
    // the tokens have been billed.
    return Math.max(1, Math.ceil(estimate));
  }
}

/**
 * Per-message overhead, in tokens.
 *
 * Every provider wraps a message in role markers and separators. The exact number varies — 3 to 7
 * across the major providers — and 4 is the middle. It matters more than it looks: a hundred-turn
 * conversation carries 400 tokens of pure structure, which is enough to overflow a context window
 * that arithmetic said would fit.
 */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Overhead for the conversation as a whole: the priming the provider adds. */
const CONVERSATION_OVERHEAD_TOKENS = 3;

/**
 * Overhead per tool definition.
 *
 * A tool is serialised into the prompt as JSON — name, description and full parameter schema —
 * and a dozen tools is easily two thousand tokens the caller never wrote. Counting them is the
 * difference between a context estimate that holds and one that is wrong precisely when an agent
 * has the most tools.
 */
const TOOL_DEFINITION_OVERHEAD_TOKENS = 8;

export interface TokenEstimate {
  tokens: number;
  /** Always true from this package. Named so a caller cannot forget. */
  estimated: true;
  /** Which tokeniser produced it, for a report that needs to say. */
  tokenizer: string;
}

export class TokenMeter {
  constructor(private readonly tokenizer: Tokenizer = new HeuristicTokenizer()) {}

  text(value: string): number {
    return this.tokenizer.count(value);
  }

  /** One message, including its structural overhead. */
  message(value: Message): number {
    let tokens = MESSAGE_OVERHEAD_TOKENS;

    if (value.content) tokens += this.tokenizer.count(value.content);
    if (value.name) tokens += this.tokenizer.count(value.name);

    for (const call of value.toolCalls ?? []) {
      // The name, the arguments, and the wrapper the provider adds around each call.
      tokens += this.tokenizer.count(call.name) + this.tokenizer.count(call.arguments) + 4;
    }

    return tokens;
  }

  /** A whole conversation, plus tool definitions if any are being sent. */
  conversation(messages: Message[], tools: ToolDefinition[] = []): TokenEstimate {
    let tokens = CONVERSATION_OVERHEAD_TOKENS;

    for (const value of messages) tokens += this.message(value);
    for (const tool of tools) tokens += this.toolDefinition(tool);

    return { tokens, estimated: true, tokenizer: this.tokenizer.name };
  }

  /** One tool definition as the provider will serialise it. */
  toolDefinition(tool: ToolDefinition): number {
    return (
      TOOL_DEFINITION_OVERHEAD_TOKENS +
      this.tokenizer.count(tool.name) +
      this.tokenizer.count(tool.description) +
      // The parameter schema goes on the wire as JSON, so its serialised size is what costs.
      this.tokenizer.count(JSON.stringify(tool.parameters))
    );
  }

  /**
   * Whether a request fits, and how much room is left.
   *
   * The check that stops a request failing at the provider after the prompt tokens have already
   * been counted and billed. `headroom` is what remains for output after the prompt.
   */
  fits(
    messages: Message[],
    options: { contextTokens: number; maxOutputTokens: number; tools?: ToolDefinition[] },
  ): {
    fits: boolean;
    promptTokens: number;
    headroom: number;
    detail: string;
  } {
    const estimate = this.conversation(messages, options.tools ?? []);
    const required = estimate.tokens + options.maxOutputTokens;
    const headroom = options.contextTokens - estimate.tokens;

    if (required <= options.contextTokens) {
      return {
        fits: true,
        promptTokens: estimate.tokens,
        headroom,
        detail: `About ${estimate.tokens} prompt tokens, leaving ${headroom} of ${options.contextTokens}.`,
      };
    }

    return {
      fits: false,
      promptTokens: estimate.tokens,
      headroom,
      detail:
        `About ${estimate.tokens} prompt tokens plus ${options.maxOutputTokens} of output needs ` +
        `${required}, and the window is ${options.contextTokens}. Shorten the conversation, ` +
        `lower maxOutputTokens, or route to a model with a larger window. ` +
        `(This is an estimate from the ${estimate.tokenizer} tokeniser and rounds up.)`,
    };
  }
}

/**
 * Reconciles an estimate against what the provider actually charged.
 *
 * Worth measuring: an estimator that is 40% low makes every context check unreliable, and the
 * only way to know is to compare. `trustos ai doctor` reports the running drift.
 */
export function estimateDrift(
  estimated: number,
  actual: number,
): { ratio: number; percent: number; direction: 'over' | 'under' | 'exact' } {
  if (actual === 0) return { ratio: 1, percent: 0, direction: 'exact' };

  const ratio = estimated / actual;
  const percent = Math.round((ratio - 1) * 100);

  return {
    ratio,
    percent,
    direction: percent > 0 ? 'over' : percent < 0 ? 'under' : 'exact',
  };
}
