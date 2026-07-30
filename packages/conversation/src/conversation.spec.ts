import { beforeEach, describe, expect, it, vi } from 'vitest';
import { message, type Message } from '@trustos/ai-sdk';
import { TokenMeter } from '@trustos/token-meter';
import { ConversationService, groupToolPairs } from './conversation';
import { InMemoryConversationStore } from './testing';

/**
 * Two things are worth testing here and the rest is bookkeeping.
 *
 * The first is that fitting a conversation into a context window never produces a *broken*
 * conversation — a tool result answering nothing, or a run with no system prompt. Providers reject
 * the first outright; the second changes the agent's behaviour with no error anywhere.
 *
 * The second is that dropping history is never silent.
 */

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function service(
  options: { summarise?: ConstructorParameters<typeof ConversationService>[0]['summarise'] } = {},
) {
  const store = new InMemoryConversationStore();

  const conversations = new ConversationService({
    store,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
    ...options,
  });

  return { store, conversations };
}

const longText = (words: number) => Array.from({ length: words }, () => 'context').join(' ');

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('turns', () => {
  it('records a turn and accumulates cost on the conversation', async () => {
    const { conversations, store } = service();
    const conversation = await conversations.start({ organizationId: 'org_a', userId: 'usr_1' });

    await conversations.append({
      conversationId: conversation.id,
      organizationId: 'org_a',
      message: message.user('Where is my transfer?'),
    });

    await conversations.append({
      conversationId: conversation.id,
      organizationId: 'org_a',
      message: message.assistant('Let me look.'),
      modelId: 'test.small',
      tokens: 120,
      costCents: 3,
    });

    expect(store.conversations.get(conversation.id)).toMatchObject({
      totalTokens: 120,
      totalCostCents: 3,
    });
  });

  it('refuses to append to another tenant’s conversation', async () => {
    const { conversations } = service();
    const conversation = await conversations.start({ organizationId: 'org_a' });

    await expect(
      conversations.append({
        conversationId: conversation.id,
        organizationId: 'org_b',
        message: message.user('hello'),
      }),
    ).rejects.toThrow(/No conversation/);
  });

  it('does not let one tenant close another’s conversation', async () => {
    // `ConversationStore.update` takes no tenant, so the check has to happen before the write.
    const { conversations, store } = service();
    const conversation = await conversations.start({ organizationId: 'org_a' });

    await expect(conversations.complete(conversation.id, 'org_b')).rejects.toThrow(
      /No conversation/,
    );
    expect(store.conversations.get(conversation.id)!.status).toBe('active');

    await conversations.complete(conversation.id, 'org_a');
    expect(store.conversations.get(conversation.id)!.status).toBe('completed');
  });

  it('keeps sequence numbers stable across compaction', async () => {
    // A sequence that restarts at zero after compaction makes two different turns share a number,
    // and any ordering or citation keyed on it silently points at the wrong one.
    const { conversations, store } = service({
      summarise: async () => 'Earlier: the customer asked about a transfer.',
    });

    const conversation = await conversations.start({ organizationId: 'org_a' });

    for (let index = 0; index < 12; index += 1) {
      await conversations.append({
        conversationId: conversation.id,
        organizationId: 'org_a',
        message: message.user(`message ${index}`),
      });
    }

    await conversations.compact({
      conversationId: conversation.id,
      organizationId: 'org_a',
      keepRecent: 4,
    });

    await conversations.append({
      conversationId: conversation.id,
      organizationId: 'org_a',
      message: message.user('after compaction'),
    });

    const sequences = (store.turnsByConversation.get(conversation.id) ?? []).map(
      (turn) => turn.sequence,
    );

    expect(new Set(sequences).size).toBe(sequences.length);
    expect(Math.max(...sequences)).toBe(12);
  });
});

describe('messages', () => {
  it('prepends the summary as a system message', async () => {
    const { conversations } = service({ summarise: async () => 'They asked about a transfer.' });
    const conversation = await conversations.start({ organizationId: 'org_a' });

    for (let index = 0; index < 6; index += 1) {
      await conversations.append({
        conversationId: conversation.id,
        organizationId: 'org_a',
        message: message.user(`message ${index}`),
      });
    }

    await conversations.compact({
      conversationId: conversation.id,
      organizationId: 'org_a',
      keepRecent: 2,
    });

    const messages = await conversations.messages(conversation.id, 'org_a');

    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]!.content).toMatch(/They asked about a transfer\./);
    expect(messages).toHaveLength(3);
  });

  it('preserves tool call ids through storage', async () => {
    const { conversations } = service();
    const conversation = await conversations.start({ organizationId: 'org_a' });

    await conversations.append({
      conversationId: conversation.id,
      organizationId: 'org_a',
      message: message.assistant(null, [
        { id: 'call_1', name: 'search_orders', arguments: '{"query":"ORD-1"}' },
      ]),
    });

    await conversations.append({
      conversationId: conversation.id,
      organizationId: 'org_a',
      message: message.tool('call_1', '[]'),
    });

    const messages = await conversations.messages(conversation.id, 'org_a');

    expect(messages[0]).toMatchObject({ toolCalls: [{ id: 'call_1' }] });
    expect(messages[1]).toMatchObject({ role: 'tool', toolCallId: 'call_1' });
  });
});

describe('fitting a context window', () => {
  const meter = new TokenMeter();

  it('keeps the system prompt and drops the oldest turns', async () => {
    const { conversations } = service();

    const messages: Message[] = [
      message.system('You are a support agent.'),
      ...Array.from({ length: 20 }, (_, index) => message.user(`${index} ${longText(60)}`)),
    ];

    const result = conversations.fit({ messages, contextTokens: 2000, maxOutputTokens: 500 });

    expect(result.messages[0]).toMatchObject({ role: 'system' });
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
    // The most recent turn always survives — it is the question being answered.
    expect(result.messages[result.messages.length - 1]!.content).toMatch(/^19 /);
  });

  it('reports that a summary is needed rather than dropping silently', async () => {
    const { conversations } = service();

    const messages: Message[] = [
      message.system('You are a support agent.'),
      ...Array.from({ length: 20 }, (_, index) => message.user(`${index} ${longText(60)}`)),
    ];

    expect(
      conversations.fit({ messages, contextTokens: 2000, maxOutputTokens: 500 }).needsSummary,
    ).toBe(true);

    expect(
      conversations.fit({ messages, contextTokens: 200_000, maxOutputTokens: 500 }).needsSummary,
    ).toBe(false);
  });

  it('never splits a tool call from its result', async () => {
    /*
     * The failure this prevents is not "slightly worse context". A tool message whose assistant
     * turn was dropped makes most providers reject the entire request.
     */
    const { conversations } = service();

    const pairs: Message[] = Array.from({ length: 12 }, (_, index) => [
      message.assistant(null, [
        { id: `call_${index}`, name: 'lookup', arguments: `{"id":"${index}"}` },
      ]),
      message.tool(`call_${index}`, longText(200)),
    ]).flat();

    const result = conversations.fit({
      messages: [message.system('You are a support agent.'), ...pairs],
      contextTokens: 3000,
      maxOutputTokens: 500,
    });

    expect(result.dropped).toBeGreaterThan(0);

    const callIds = new Set(
      result.messages.flatMap((entry) => entry.toolCalls?.map((call) => call.id) ?? []),
    );

    for (const entry of result.messages) {
      if (entry.role === 'tool') expect(callIds.has(entry.toolCallId!)).toBe(true);
    }
  });

  it('says plainly when the system prompt alone does not fit', async () => {
    // Trimming the conversation cannot help, and a message that only says "too long" sends
    // somebody looking in the wrong place.
    const { conversations } = service();

    const result = conversations.fit({
      messages: [message.system(longText(5000)), message.user('hello')],
      contextTokens: 2000,
      maxOutputTokens: 500,
    });

    expect(result.impossible).toMatch(/Shorten the system prompt/);
    expect(result.messages.every((entry) => entry.role === 'system')).toBe(true);
  });

  it('reserves room for the next turn’s tool results when asked', async () => {
    const { conversations } = service();

    const messages: Message[] = [
      message.system('You are a support agent.'),
      ...Array.from({ length: 20 }, (_, index) => message.user(`${index} ${longText(100)}`)),
    ];

    const without = conversations.fit({ messages, contextTokens: 4000, maxOutputTokens: 500 });
    const withReserve = conversations.fit({
      messages,
      contextTokens: 4000,
      maxOutputTokens: 500,
      reserveTokens: 1500,
    });

    expect(withReserve.messages.length).toBeLessThan(without.messages.length);
  });

  it('counts tool definitions against the budget', async () => {
    // Tools live in the prompt. A fit that ignores them overflows on the request that adds one.
    const { conversations } = service();

    const messages: Message[] = [
      message.system('You are a support agent.'),
      ...Array.from({ length: 10 }, (_, index) => message.user(`${index} ${longText(40)}`)),
    ];

    const tools = Array.from({ length: 8 }, (_, index) => ({
      name: `tool_${index}`,
      description: longText(60),
      parameters: { type: 'object', properties: {} },
    }));

    const without = conversations.fit({ messages, contextTokens: 1800, maxOutputTokens: 500 });
    const withTools = conversations.fit({
      messages,
      contextTokens: 1800,
      maxOutputTokens: 500,
      tools,
    });

    expect(withTools.messages.length).toBeLessThan(without.messages.length);
    expect(meter.toolDefinition(tools[0]!)).toBeGreaterThan(0);
  });
});

describe('compaction', () => {
  it('refuses without a summariser rather than dropping history', async () => {
    const { conversations } = service();
    const conversation = await conversations.start({ organizationId: 'org_a' });

    await expect(
      conversations.compact({ conversationId: conversation.id, organizationId: 'org_a' }),
    ).rejects.toThrow(/No summariser is configured/);
  });

  it('does nothing when there is less history than it would keep', async () => {
    const summarise = vi.fn(async () => 'summary');
    const { conversations } = service({ summarise });
    const conversation = await conversations.start({ organizationId: 'org_a' });

    await conversations.append({
      conversationId: conversation.id,
      organizationId: 'org_a',
      message: message.user('hello'),
    });

    const result = await conversations.compact({
      conversationId: conversation.id,
      organizationId: 'org_a',
      keepRecent: 10,
    });

    expect(result.summarised).toBe(0);
    expect(summarise).not.toHaveBeenCalled();
  });

  it('folds an existing summary into the new one rather than replacing it', async () => {
    // Replacing it loses the first compaction's content on the second, which is exactly when a
    // conversation is long enough for that content to matter.
    const seen: Array<string | null> = [];

    const { conversations } = service({
      summarise: async (input) => {
        seen.push(input.existingSummary);
        return `summary ${seen.length}`;
      },
    });

    const conversation = await conversations.start({ organizationId: 'org_a' });

    for (let index = 0; index < 20; index += 1) {
      await conversations.append({
        conversationId: conversation.id,
        organizationId: 'org_a',
        message: message.user(`message ${index}`),
      });
    }

    await conversations.compact({
      conversationId: conversation.id,
      organizationId: 'org_a',
      keepRecent: 5,
    });

    for (let index = 0; index < 10; index += 1) {
      await conversations.append({
        conversationId: conversation.id,
        organizationId: 'org_a',
        message: message.user(`later ${index}`),
      });
    }

    await conversations.compact({
      conversationId: conversation.id,
      organizationId: 'org_a',
      keepRecent: 5,
    });

    expect(seen).toEqual([null, 'summary 1']);
  });
});

describe('groupToolPairs', () => {
  it('groups an assistant tool call with every result answering it', () => {
    const grouped = groupToolPairs([
      message.user('do it'),
      message.assistant(null, [
        { id: 'call_1', name: 'a', arguments: '{}' },
        { id: 'call_2', name: 'b', arguments: '{}' },
      ]),
      message.tool('call_1', 'ok'),
      message.tool('call_2', 'ok'),
      message.assistant('Done.'),
    ]);

    expect(grouped.map((group) => group.length)).toEqual([1, 3, 1]);
  });

  it('does not swallow the following turn into a tool group', () => {
    const grouped = groupToolPairs([
      message.assistant(null, [{ id: 'call_1', name: 'a', arguments: '{}' }]),
      message.tool('call_1', 'ok'),
      message.user('and now this'),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[1]).toEqual([message.user('and now this')]);
  });
});
