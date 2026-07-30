import { describe, expect, it } from 'vitest';
import { aiErrorReason, AiError } from './errors';
import {
  FINISH_REASON_DETAIL,
  isComplete,
  message,
  messageSchema,
  toolCallSchema,
} from './messages';
import { buildCompletionRequest, completionRequestSchema, usageSchema } from './request';

function issuesOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const details = (error as { details?: Array<{ path: string; message: string }> }).details ?? [];
    const issues = (error as { errors?: Array<{ path: unknown[]; message: string }> }).errors ?? [];
    return [
      (error as Error).message,
      ...details.map((entry) => `${entry.path}: ${entry.message}`),
      ...issues.map((entry) => `${entry.path.join('.')}: ${entry.message}`),
    ].join(' | ');
  }
  throw new Error('Expected the call to throw, and it did not.');
}

describe('messages', () => {
  it('builds each role', () => {
    expect(message.system('be helpful')).toEqual({ role: 'system', content: 'be helpful' });
    expect(message.user('hello')).toEqual({ role: 'user', content: 'hello' });
    expect(message.tool('call_1', '42')).toEqual({
      role: 'tool',
      content: '42',
      toolCallId: 'call_1',
    });
  });

  it('allows an assistant message that is only tool calls', () => {
    const assistant = message.assistant(null, [
      { id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
    ]);

    expect(messageSchema.safeParse(assistant).success).toBe(true);
  });

  it('refuses a message carrying nothing at all', () => {
    // Almost always a builder that forgot to set the text.
    expect(messageSchema.safeParse({ role: 'assistant', content: null }).success).toBe(false);
  });

  it('refuses a tool message with no call to answer', () => {
    // Most providers reject the whole conversation, so catching it here is cheaper.
    const result = messageSchema.safeParse({ role: 'tool', content: '42' });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/name the call it answers/);
  });

  it('refuses tool calls on a non-assistant message', () => {
    const result = messageSchema.safeParse({
      role: 'user',
      content: 'x',
      toolCalls: [{ id: 'c', name: 'n', arguments: '{}' }],
    });

    expect(result.success).toBe(false);
  });

  it('carries tool arguments as a string, because providers emit malformed JSON', () => {
    // Parsing here would make the type unable to represent what the provider actually sent.
    const truncated = { id: 'call_1', name: 'search', arguments: '{"query":"unfinis' };

    expect(toolCallSchema.safeParse(truncated).success).toBe(true);
  });

  it('rejects an unknown message field rather than passing it to a provider', () => {
    expect(messageSchema.safeParse({ role: 'user', content: 'x', temperature: 0.5 }).success).toBe(
      false,
    );
  });
});

describe('finish reasons', () => {
  it.each([
    ['stop', true],
    ['tool_calls', true],
    ['length', false],
    ['content_filter', false],
    ['cancelled', false],
    ['error', false],
  ] as const)('isComplete(%s) is %s', (reason, expected) => {
    expect(isComplete(reason)).toBe(expected);
  });

  it('explains truncation in terms of what to do about it', () => {
    // The failure this prevents: truncated JSON reported as "the model produced bad JSON", which
    // sends somebody to fix a prompt when the fix is a larger maxOutputTokens.
    expect(FINISH_REASON_DETAIL.length).toMatch(/truncated.*maxOutputTokens/);
  });

  it('distinguishes a provider refusal from a TrustOS guardrail', () => {
    expect(FINISH_REASON_DETAIL.content_filter).toMatch(/not a TrustOS guardrail/);
  });
});

describe('completion requests', () => {
  const base = {
    messages: [message.user('hello')],
    model: { kind: 'requirement' as const, profile: 'balanced', capabilities: [] },
    maxOutputTokens: 1000,
  };

  it('accepts a requirement rather than a model name', () => {
    expect(() => buildCompletionRequest(base)).not.toThrow();
  });

  it('accepts an explicit model when a caller genuinely needs one', () => {
    expect(() =>
      buildCompletionRequest({ ...base, model: { kind: 'model', modelId: 'test.small' } }),
    ).not.toThrow();
  });

  it('requires maxOutputTokens, unlike every provider API', () => {
    // An unbounded generation is an unbounded bill and an unbounded latency.
    const { maxOutputTokens, ...withoutLimit } = base;
    void maxOutputTokens;

    expect(completionRequestSchema.safeParse(withoutLimit).success).toBe(false);
  });

  it('refuses an empty conversation', () => {
    expect(completionRequestSchema.safeParse({ ...base, messages: [] }).success).toBe(false);
  });

  it('refuses two tools with the same name', () => {
    // Which one the model calls would be undefined, and providers resolve it silently.
    expect(
      issuesOf(() =>
        buildCompletionRequest({
          ...base,
          tools: [
            { name: 'search', description: 'a', parameters: {} },
            { name: 'search', description: 'b', parameters: {} },
          ],
        }),
      ),
    ).toMatch(/Two tools share a name/);
  });

  it('refuses a tool name a provider would reject', () => {
    expect(
      completionRequestSchema.safeParse({
        ...base,
        tools: [{ name: 'search files!', description: 'a', parameters: {} }],
      }).success,
    ).toBe(false);
  });

  it('refuses toolChoice with no tools', () => {
    expect(issuesOf(() => buildCompletionRequest({ ...base, toolChoice: 'required' }))).toMatch(
      /nothing to choose/,
    );
  });

  it('leaves temperature unset rather than inventing a default', () => {
    // A framework default of 0.7 would override a provider default that may be better tuned.
    expect(buildCompletionRequest(base).temperature).toBeUndefined();
  });

  it('keeps providerOptions untouched, as the escape hatch', () => {
    // An intersection with no escape hatch forces somebody to bypass the gateway.
    const request = buildCompletionRequest({
      ...base,
      providerOptions: { anthropic_beta: 'x', nested: { a: 1 } },
    });

    expect(request.providerOptions).toEqual({ anthropic_beta: 'x', nested: { a: 1 } });
  });

  it('refuses an unknown top-level field', () => {
    expect(completionRequestSchema.safeParse({ ...base, stream: true }).success).toBe(false);
  });

  it('defaults a json_schema response to strict', () => {
    // A caller that asked for a schema and got something else has a failure, not a success.
    const request = buildCompletionRequest({
      ...base,
      responseFormat: { kind: 'json_schema', name: 'Out', schema: { type: 'object' } },
    });

    expect(request.responseFormat).toMatchObject({ strict: true });
  });
});

describe('usage', () => {
  it('defaults reasoning and cached tokens to zero', () => {
    const usage = usageSchema.parse({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    expect(usage).toMatchObject({ reasoningTokens: 0, cachedPromptTokens: 0, estimated: false });
  });

  it('records whether the numbers are measured or estimated', () => {
    // A cost report that cannot tell the difference is one nobody can reconcile against an
    // invoice.
    const estimated = usageSchema.parse({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: true,
    });

    expect(estimated.estimated).toBe(true);
  });
});

describe('AI errors', () => {
  it('names what is registered when a model is unknown', () => {
    expect(
      issuesOf(() => {
        throw AiError.modelUnknown('gpt-9', ['test.small', 'test.large']);
      }),
    ).toMatch(/Registered: test\.small, test\.large/);
  });

  it('truncates a long registry list rather than printing forty ids', () => {
    const many = Array.from({ length: 25 }, (_, index) => `model-${index}`);

    expect(
      issuesOf(() => {
        throw AiError.modelUnknown('x', many);
      }),
    ).toMatch(/and 15 more/);
  });

  it.each([
    ['policyDenied', 403],
    ['guardrailBlocked', 403],
    ['toolDenied', 403],
    ['budgetExceeded', 429],
    ['providerUnavailable', 429],
  ] as const)('%s maps to status %d', (factory, status) => {
    const error = AiError[factory]('detail') as unknown as { status: number };
    expect(error.status).toBe(status);
  });

  it('exposes a reason a caller can branch on', () => {
    // Branching on `error.message` breaks when somebody improves the wording.
    expect(aiErrorReason(AiError.budgetExceeded('over'))).toBe('budget_exceeded');
    expect(aiErrorReason(new Error('plain'))).toBeNull();
  });
});
