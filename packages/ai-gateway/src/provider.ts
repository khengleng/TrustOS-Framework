import { z } from 'zod';
import type {
  CompletionChunk,
  CompletionRequest,
  FinishReason,
  Message,
  ToolCall,
  ToolDefinition,
  Usage,
} from '@trustos/ai-sdk';
import type { Model } from '@trustos/model-registry';

/**
 * The provider adapter contract.
 *
 * One interface, every provider. An adapter translates between the framework's vocabulary and a
 * provider's, and does nothing else — no retry, no cost accounting, no policy, no guardrails.
 * Those belong to the gateway and are the same for every provider, so putting them in an adapter
 * would mean six implementations of each and six chances to get one wrong.
 *
 * **The framework ships no adapter that calls a real provider.** The contract is here, an echo
 * adapter for tests is here, and that is the phase boundary — the same one phase 6 drew for
 * `Provider`. Writing an adapter against this is a few hundred lines; unpicking one that was
 * imposed on every deployment is a quarter.
 *
 * What an adapter must get right, and what the gateway cannot do for it:
 *
 *   * **Normalise the finish reason.** Every provider names truncation differently, and a caller
 *     that had to know which provider it was talking to would have a provider dependency.
 *   * **Report usage honestly.** If the provider did not return token counts — common when
 *     streaming — say so with `estimated: true` rather than returning zeros. Zeros look like a
 *     free request and quietly corrupt every cost report downstream.
 *   * **Surface a refusal as `content_filter`**, not as an error. The provider's own safety filter
 *     refusing is a different thing from the provider being down, and conflating them makes a
 *     refusal look retryable.
 */

export interface ProviderCallInput {
  request: CompletionRequest;
  /** The resolved model. The adapter uses `providerModelId`, not the registry id. */
  model: Model;
  /** Cancelled on timeout or caller abort. An adapter must honour it. */
  signal: AbortSignal;
}

export interface ProviderCallResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
  /** Anything the provider returned that does not fit. Kept for debugging, never for logic. */
  raw?: Record<string, unknown>;
}

export interface AiProviderAdapter {
  /** Matches `Model.provider`. */
  readonly key: string;
  readonly displayName: string;

  /**
   * Whether this adapter can serve a request.
   *
   * Asked before the call, so an unsupported feature is a clear refusal rather than a provider
   * error three seconds and one billable call later.
   */
  supports(request: CompletionRequest, model: Model): { ok: true } | { ok: false; reason: string };

  complete(input: ProviderCallInput): Promise<ProviderCallResult>;

  /** Streaming. Absent when the provider or the adapter does not support it. */
  stream?(input: ProviderCallInput): AsyncIterable<CompletionChunk>;

  /** Cheap reachability check. Must not throw — see `AdapterHealth`. */
  health?(): Promise<AdapterHealth>;

  /** Releases connections on shutdown. */
  shutdown?(): Promise<void>;
}

export interface AdapterHealth {
  status: 'healthy' | 'degraded' | 'unavailable';
  detail: string;
  latencyMs: number;
}

/**
 * Classifies a provider error.
 *
 * The gateway needs three things from a failure and cannot get them from an exception type: is it
 * worth retrying, is this model specifically broken, and did the provider refuse on safety
 * grounds. An adapter throws `ProviderError` with these set.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly detail: {
      /** Worth another attempt: a 5xx, a timeout, a rate limit. */
      retryable: boolean;
      /**
       * This *model* is the problem, not the provider.
       *
       * A 404 on the model, or a "model overloaded". The gateway marks it unavailable in the
       * registry so the router stops choosing it, which is what makes an outage self-healing.
       */
      modelUnavailable?: boolean;
      /** The provider's safety filter refused. Not an outage, not retryable. */
      refused?: boolean;
      status?: number;
      provider?: string;
      modelId?: string;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * An adapter that echoes its input.
 *
 * For tests, for `trustos ai doctor`, and for a development environment with no provider
 * credentials. Named for what it is, so nobody wires it into production believing it thinks.
 *
 * It is genuinely useful beyond tests: an application can be built end to end — prompts, agents,
 * tools, guardrails, cost accounting — before anybody has a provider account, and every piece
 * except the model's judgement is exercised.
 */
export class EchoAdapter implements AiProviderAdapter {
  readonly key: string;
  readonly displayName = 'Echo (test adapter)';

  constructor(
    key = 'echo',
    private readonly options: {
      /** Fixed response, when a test wants one. */
      respondWith?: string | ((request: CompletionRequest) => string);
      /** Tool calls to emit, for exercising the agent loop. */
      toolCalls?: ToolCall[] | ((request: CompletionRequest) => ToolCall[]);
      finishReason?: FinishReason;
      /** Simulated latency. */
      delayMs?: number;
      /** Throws instead, for exercising retry and fallback. */
      failWith?: ProviderError;
    } = {},
  ) {
    this.key = key;
  }

  supports(): { ok: true } {
    return { ok: true };
  }

  async complete(input: ProviderCallInput): Promise<ProviderCallResult> {
    if (this.options.failWith) throw this.options.failWith;

    if (this.options.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.delayMs);
        input.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            const error = new Error('The request was aborted.');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    }

    const toolCalls =
      typeof this.options.toolCalls === 'function'
        ? this.options.toolCalls(input.request)
        : (this.options.toolCalls ?? []);

    const content =
      toolCalls.length > 0 && this.options.respondWith === undefined
        ? null
        : typeof this.options.respondWith === 'function'
          ? this.options.respondWith(input.request)
          : (this.options.respondWith ?? lastUserText(input.request.messages));

    const promptTokens = estimateTokens(input.request.messages, input.request.tools);
    const completionTokens = Math.ceil((content?.length ?? 0) / 4);

    return {
      content,
      toolCalls,
      finishReason: this.options.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage: {
        promptTokens,
        completionTokens,
        reasoningTokens: 0,
        cachedPromptTokens: 0,
        totalTokens: promptTokens + completionTokens,
        // Honest: these are counted here, not reported by a provider.
        estimated: true,
      },
    };
  }

  async *stream(input: ProviderCallInput): AsyncIterable<CompletionChunk> {
    const result = await this.complete(input);

    for (const word of (result.content ?? '').split(' ')) {
      if (input.signal.aborted) {
        yield { kind: 'finish', reason: 'cancelled' };
        return;
      }
      yield { kind: 'content', delta: `${word} ` };
    }

    yield { kind: 'finish', reason: result.finishReason, usage: result.usage };
  }

  async health(): Promise<AdapterHealth> {
    return { status: 'healthy', detail: 'The echo adapter is always available.', latencyMs: 0 };
  }
}

function lastUserText(messages: Message[]): string {
  const last = [...messages].reverse().find((entry) => entry.role === 'user');
  return last?.content ?? '';
}

function estimateTokens(messages: Message[], tools?: ToolDefinition[]): number {
  const text = messages.map((entry) => entry.content ?? '').join(' ');
  const toolText = JSON.stringify(tools ?? []);
  return Math.ceil((text.length + toolText.length) / 4) + messages.length * 4;
}

/** Configuration every adapter needs. A deployment supplies it per provider. */
export const adapterConfigSchema = z
  .object({
    /** The provider key. Matches `Model.provider`. */
    provider: z.string().min(1).max(60),
    /**
     * Never logged, never in an error, never in a health response.
     *
     * Held here rather than read from the environment inside an adapter, so a deployment can
     * source it from a secret manager without every adapter growing its own loader.
     */
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    /** Per-request ceiling. The gateway also applies its own. */
    timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
    /** Extra headers. For an organization id, a project, a deployment name. */
    headers: z.record(z.string()).default({}),
  })
  .strict();

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

/**
 * Redacts a configuration for logging or a health response.
 *
 * Exported rather than left to each adapter, because "redact the key before logging" is a rule
 * every adapter must follow and one that six implementations will follow five times.
 */
export function redactAdapterConfig(config: AdapterConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl ?? null,
    timeoutMs: config.timeoutMs,
    // Presence, never the value, and never a prefix — a prefix plus a leaked length is a
    // meaningful head start.
    apiKey: config.apiKey ? '[SET]' : '[NOT SET]',
    headerNames: Object.keys(config.headers).sort(),
  };
}
