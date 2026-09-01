import { describe, expect, it } from 'vitest';
import { message, type Message, type ToolDefinition } from '@trustsystem/ai-sdk';
import { HeuristicTokenizer, TokenMeter, estimateDrift } from './counter';

const meter = new TokenMeter();

describe('the heuristic tokenizer', () => {
  it('counts nothing for an empty string', () => {
    expect(new HeuristicTokenizer().count('')).toBe(0);
  });

  it('estimates English prose in a plausible range', () => {
    // ~57 characters. A real tokeniser gives 12–14; the estimate should be near that and above.
    const text = 'The quick brown fox jumps over the lazy dog repeatedly.';
    const tokens = new HeuristicTokenizer().count(text);

    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(25);
  });

  it('does not under-count non-Latin script', () => {
    /*
     * The case a ÷4 heuristic gets badly wrong. Khmer tokenises at roughly one token per
     * character, so an estimate built for English under-counts by 3–4× — which in a Cambodian
     * deployment is not an edge case.
     */
    const khmer = 'សួស្តី​ពិភពលោក​នេះ​ជា​ការ​សាកល្បង';
    const naive = Math.ceil(khmer.length / 4);

    expect(new HeuristicTokenizer().count(khmer)).toBeGreaterThan(naive * 2);
  });

  it('rounds up rather than down', () => {
    // An under-estimate becomes a failed request after the tokens have already been billed.
    expect(new HeuristicTokenizer().count('a')).toBe(1);
  });

  it('counts indented JSON without inflating it for the whitespace', () => {
    const compact = JSON.stringify({ a: 1, b: [1, 2, 3] });
    const indented = JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2);
    const tokenizer = new HeuristicTokenizer();

    // Indentation compresses well; it should cost something, but not proportionally.
    expect(tokenizer.count(indented)).toBeGreaterThan(tokenizer.count(compact));
    expect(tokenizer.count(indented)).toBeLessThan(tokenizer.count(compact) * 2);
  });

  it('accepts an injected tokenizer, for a deployment that wants exactness', () => {
    const exact = { name: 'fake-exact', count: (text: string) => text.length };

    expect(new TokenMeter(exact).text('hello')).toBe(5);
  });
});

describe('messages', () => {
  it('charges per-message overhead, which a hundred-turn conversation makes visible', () => {
    // 400 tokens of pure structure is enough to overflow a window that arithmetic said would fit.
    const empty = meter.message(message.user(''));

    expect(empty).toBeGreaterThanOrEqual(4);
  });

  it('counts tool calls on an assistant message', () => {
    const withCall = meter.message(
      message.assistant(null, [{ id: 'c1', name: 'search', arguments: '{"query":"hello world"}' }]),
    );

    expect(withCall).toBeGreaterThan(meter.message(message.assistant('hi')));
  });

  it('counts a conversation as more than the sum of its text', () => {
    const messages: Message[] = [message.system('be brief'), message.user('hi')];
    const textOnly = meter.text('be brief') + meter.text('hi');

    expect(meter.conversation(messages).tokens).toBeGreaterThan(textOnly);
  });

  it('always reports itself as an estimate', () => {
    const estimate = meter.conversation([message.user('hi')]);

    expect(estimate.estimated).toBe(true);
    expect(estimate.tokenizer).toBe('heuristic');
  });
});

describe('tool definitions', () => {
  const tool: ToolDefinition = {
    name: 'search_documents',
    description: 'Searches the knowledge base for relevant passages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: { type: 'integer', description: 'How many results.' },
      },
      required: ['query'],
    },
  };

  it('counts the serialised schema, not just the name', () => {
    // A dozen tools is easily two thousand tokens the caller never wrote.
    expect(meter.toolDefinition(tool)).toBeGreaterThan(30);
  });

  it('includes tools in the conversation estimate', () => {
    const without = meter.conversation([message.user('hi')]).tokens;
    const with_ = meter.conversation([message.user('hi')], [tool]).tokens;

    expect(with_ - without).toBe(meter.toolDefinition(tool));
  });
});

describe('context fitting', () => {
  const short = [message.user('hello')];

  it('reports a comfortable fit with the headroom', () => {
    const result = meter.fits(short, { contextTokens: 100_000, maxOutputTokens: 1000 });

    expect(result.fits).toBe(true);
    expect(result.headroom).toBeGreaterThan(90_000);
  });

  it('refuses when the prompt plus the output exceeds the window', () => {
    const result = meter.fits(short, { contextTokens: 100, maxOutputTokens: 200 });

    expect(result.fits).toBe(false);
    expect(result.detail).toMatch(/Shorten the conversation, lower maxOutputTokens/);
  });

  it('says the estimate rounds up, so a near-miss is explicable', () => {
    const result = meter.fits(short, { contextTokens: 10, maxOutputTokens: 10 });

    expect(result.detail).toMatch(/estimate from the heuristic tokeniser and rounds up/);
  });

  it('counts tools against the window', () => {
    // The check is wrong precisely when an agent has the most tools, if tools are not counted.
    const tools: ToolDefinition[] = Array.from({ length: 12 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'A tool with a reasonably long description that costs tokens to serialise.',
      parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
    }));

    const without = meter.fits(short, { contextTokens: 600, maxOutputTokens: 100 });
    const with_ = meter.fits(short, { contextTokens: 600, maxOutputTokens: 100, tools });

    expect(without.fits).toBe(true);
    expect(with_.fits).toBe(false);
  });
});

describe('estimate drift', () => {
  it('reports over-estimation as a positive percentage', () => {
    expect(estimateDrift(120, 100)).toMatchObject({ percent: 20, direction: 'over' });
  });

  it('reports under-estimation, which is the direction that matters', () => {
    // An estimator that is 40% low makes every context check unreliable.
    expect(estimateDrift(60, 100)).toMatchObject({ percent: -40, direction: 'under' });
  });

  it('handles a zero actual without dividing by it', () => {
    expect(estimateDrift(10, 0)).toMatchObject({ direction: 'exact', ratio: 1 });
  });
});
