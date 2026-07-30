import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { message, type Message, type ToolDefinition } from '@trustos/ai-sdk';
import { TokenMeter } from '@trustos/token-meter';

/**
 * Conversation state and context-window fitting.
 *
 * A conversation grows and a context window does not. Something has to give, and *what* gives is
 * the decision this file exists to make well.
 *
 * The naive approach — drop the oldest messages until it fits — breaks in three specific ways:
 *
 *   1. **It drops the system prompt**, which is first. The agent then forgets its role and its
 *      constraints mid-conversation, and the symptom is an assistant that suddenly behaves
 *      differently for no visible reason.
 *   2. **It orphans tool results.** Dropping an assistant message that requested a tool while
 *      keeping the tool result leaves a result answering nothing, and most providers reject the
 *      conversation outright.
 *   3. **It loses the thread.** The user's original question is usually the oldest user message,
 *      and an agent twenty turns in that has forgotten what it was asked produces confident
 *      answers to a question nobody posed.
 *
 * So: the system prompt is pinned, tool pairs move together, and what is dropped is *summarised*
 * rather than deleted.
 */

export const conversationSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),
    userId: z.string().max(64).nullable().default(null),
    agentId: z.string().max(120).nullable().default(null),

    title: z.string().max(300).nullable().default(null),

    /**
     * A summary of what was dropped.
     *
     * Prepended to the conversation when present. Losing the early turns entirely is how an agent
     * forgets what it was asked; a summary is lossy and is far better than nothing.
     */
    summary: z.string().max(20_000).nullable().default(null),
    /** How many messages the summary covers, so the count in the UI still adds up. */
    summarisedMessageCount: z.number().int().min(0).default(0),

    status: z.enum(['active', 'completed', 'abandoned']).default('active'),

    totalTokens: z.number().int().min(0).default(0),
    totalCostCents: z.number().min(0).default(0),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

export type Conversation = z.infer<typeof conversationSchema>;

export const conversationTurnSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    organizationId: z.string().nullable(),
    /** Position in the conversation. Turns are never renumbered. */
    sequence: z.number().int().min(0),

    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(1_000_000).nullable(),
    toolCalls: z.unknown().nullable().default(null),
    toolCallId: z.string().max(200).nullable().default(null),

    /** Which model produced it, for an assistant turn. */
    modelId: z.string().max(120).nullable().default(null),
    tokens: z.number().int().min(0).default(0),
    costCents: z.number().min(0).default(0),

    createdAt: z.coerce.date(),
  })
  .strict();

export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

export interface ConversationStore {
  create(conversation: Conversation): Promise<Conversation>;
  find(id: string, organizationId: string | null): Promise<Conversation | null>;
  update(id: string, patch: Partial<Conversation>): Promise<Conversation | null>;
  list(input: {
    organizationId: string | null;
    userId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<Conversation[]>;

  appendTurn(turn: ConversationTurn): Promise<ConversationTurn>;
  turns(conversationId: string, organizationId: string | null): Promise<ConversationTurn[]>;
  /** Removes turns the summary now covers. */
  deleteTurnsBefore(
    conversationId: string,
    organizationId: string | null,
    sequence: number,
  ): Promise<number>;
}

export interface FitResult {
  messages: Message[];
  /** How many original messages were dropped in favour of the summary. */
  dropped: number;
  promptTokens: number;
  /** True when the conversation needs summarising to keep going. */
  needsSummary: boolean;
  /** Set when even the pinned messages do not fit. */
  impossible: string | null;
}

export interface ConversationServiceOptions {
  store: ConversationStore;
  meter?: TokenMeter;
  /**
   * Summarises dropped turns.
   *
   * A port rather than an implementation, because summarising well needs a model call — and a
   * conversation service that made model calls would depend on the gateway, which depends on
   * everything.
   */
  summarise?: (input: { messages: Message[]; existingSummary: string | null }) => Promise<string>;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class ConversationService {
  private readonly meter: TokenMeter;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: ConversationServiceOptions) {
    this.meter = options.meter ?? new TokenMeter();
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  async start(input: {
    organizationId: string | null;
    userId?: string | null;
    agentId?: string | null;
    title?: string | null;
  }): Promise<Conversation> {
    const now = this.now();

    return this.options.store.create(
      conversationSchema.parse({
        id: this.newId('conv'),
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        agentId: input.agentId ?? null,
        title: input.title ?? null,
        summary: null,
        summarisedMessageCount: 0,
        status: 'active',
        totalTokens: 0,
        totalCostCents: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  async append(input: {
    conversationId: string;
    organizationId: string | null;
    message: Message;
    modelId?: string | null;
    tokens?: number;
    costCents?: number;
  }): Promise<ConversationTurn> {
    const conversation = await this.require(input.conversationId, input.organizationId);
    const existing = await this.options.store.turns(input.conversationId, input.organizationId);

    const turn = conversationTurnSchema.parse({
      id: this.newId('turn'),
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      // Continues past summarised turns, so a sequence number is stable for the whole life of the
      // conversation rather than shifting when history is compacted.
      sequence: conversation.summarisedMessageCount + existing.length,
      role: input.message.role,
      content: input.message.content,
      toolCalls: input.message.toolCalls ?? null,
      toolCallId: input.message.toolCallId ?? null,
      modelId: input.modelId ?? null,
      tokens: input.tokens ?? 0,
      costCents: input.costCents ?? 0,
      createdAt: this.now(),
    });

    await this.options.store.update(input.conversationId, {
      totalTokens: conversation.totalTokens + (input.tokens ?? 0),
      totalCostCents: conversation.totalCostCents + (input.costCents ?? 0),
      updatedAt: this.now(),
    });

    return this.options.store.appendTurn(turn);
  }

  /** The conversation as messages, with the summary prepended when there is one. */
  async messages(conversationId: string, organizationId: string | null): Promise<Message[]> {
    const conversation = await this.require(conversationId, organizationId);
    const turns = await this.options.store.turns(conversationId, organizationId);

    const messages: Message[] = [];

    if (conversation.summary) {
      messages.push(
        message.system(
          `Summary of the earlier part of this conversation (${conversation.summarisedMessageCount} messages):\n${conversation.summary}`,
        ),
      );
    }

    for (const turn of turns.sort((a, b) => a.sequence - b.sequence)) {
      messages.push({
        role: turn.role,
        content: turn.content,
        ...(turn.toolCalls ? { toolCalls: turn.toolCalls as never } : {}),
        ...(turn.toolCallId ? { toolCallId: turn.toolCallId } : {}),
      } as Message);
    }

    return messages;
  }

  /**
   * Fits a conversation into a context window.
   *
   * Pins the system messages, keeps the most recent turns, and moves tool pairs together. Reports
   * `needsSummary` when turns were dropped, so a caller can summarise rather than silently losing
   * them.
   */
  fit(input: {
    messages: Message[];
    contextTokens: number;
    maxOutputTokens: number;
    tools?: ToolDefinition[];
    /** Room to leave beyond the output, for the next turn's tool results. */
    reserveTokens?: number;
  }): FitResult {
    const reserve = input.reserveTokens ?? 0;
    const budget = input.contextTokens - input.maxOutputTokens - reserve;

    // Pinned. Dropping these is how an agent forgets its role mid-conversation, and the symptom
    // is an assistant that suddenly behaves differently for no visible reason.
    const pinned = input.messages.filter((entry) => entry.role === 'system');
    const rest = input.messages.filter((entry) => entry.role !== 'system');

    const pinnedTokens = this.meter.conversation(pinned, input.tools ?? []).tokens;

    if (pinnedTokens > budget) {
      return {
        messages: [...pinned],
        dropped: rest.length,
        promptTokens: pinnedTokens,
        needsSummary: false,
        impossible:
          `The system prompt and tool definitions alone need about ${pinnedTokens} tokens, and the ` +
          `budget is ${budget}. Shorten the system prompt, remove tools, or route to a model with ` +
          'a larger context window — no amount of trimming the conversation will help.',
      };
    }

    /*
     * Grouped from the end, keeping tool pairs together.
     *
     * An assistant message that requested tools and the tool messages answering it are one unit:
     * splitting them leaves a result answering nothing, and most providers reject the whole
     * conversation rather than ignoring it.
     */
    const groups = groupToolPairs(rest);

    const kept: Message[][] = [];
    let used = pinnedTokens;

    for (const group of [...groups].reverse()) {
      const groupTokens = this.meter.conversation(group).tokens;

      if (used + groupTokens > budget) break;

      kept.unshift(group);
      used += groupTokens;
    }

    const keptMessages = kept.flat();
    const dropped = rest.length - keptMessages.length;

    return {
      messages: [...pinned, ...keptMessages],
      dropped,
      promptTokens: used,
      // The signal to summarise. Without it a caller silently loses the early turns, and the agent
      // answers confidently about a question nobody posed.
      needsSummary: dropped > 0,
      impossible: null,
    };
  }

  /**
   * Summarises and compacts a conversation.
   *
   * Keeps the most recent turns verbatim and folds everything older into the summary. Needs a
   * `summarise` port; without one it refuses rather than silently dropping history.
   */
  async compact(input: {
    conversationId: string;
    organizationId: string | null;
    /** How many recent turns to keep verbatim. */
    keepRecent?: number;
  }): Promise<{ summarised: number; summary: string }> {
    if (!this.options.summarise) {
      throw ApiError.internal(
        'No summariser is configured, so this conversation cannot be compacted. Dropping the ' +
          'early turns without summarising them would make the agent answer confidently about a ' +
          'question nobody posed.',
      );
    }

    const conversation = await this.require(input.conversationId, input.organizationId);
    const turns = (await this.options.store.turns(input.conversationId, input.organizationId)).sort(
      (a, b) => a.sequence - b.sequence,
    );

    const keepRecent = input.keepRecent ?? 10;
    if (turns.length <= keepRecent) {
      return { summarised: 0, summary: conversation.summary ?? '' };
    }

    const toSummarise = turns.slice(0, turns.length - keepRecent);

    const summary = await this.options.summarise({
      messages: toSummarise.map((turn) => ({ role: turn.role, content: turn.content }) as Message),
      existingSummary: conversation.summary,
    });

    const cutoff = toSummarise[toSummarise.length - 1]!.sequence + 1;

    await this.options.store.update(input.conversationId, {
      summary,
      summarisedMessageCount: conversation.summarisedMessageCount + toSummarise.length,
      updatedAt: this.now(),
    });

    await this.options.store.deleteTurnsBefore(input.conversationId, input.organizationId, cutoff);

    return { summarised: toSummarise.length, summary };
  }

  /**
   * Marks a conversation finished.
   *
   * The tenant is checked before the update, not passed through to it. `ConversationStore.update`
   * takes an id and a patch — no tenant — so an implementation cannot scope the write itself, and
   * a caller passing an id from another tenant would otherwise close somebody else's conversation.
   */
  async complete(conversationId: string, organizationId: string | null): Promise<void> {
    await this.require(conversationId, organizationId);

    await this.options.store.update(conversationId, {
      status: 'completed',
      updatedAt: this.now(),
    });
  }

  async list(input: Parameters<ConversationStore['list']>[0]): Promise<Conversation[]> {
    return this.options.store.list(input);
  }

  private async require(id: string, organizationId: string | null): Promise<Conversation> {
    const conversation = await this.options.store.find(id, organizationId);
    if (!conversation) throw ApiError.notFound(`No conversation with id "${id}".`);
    return conversation;
  }
}

/**
 * Groups an assistant tool-call message with the tool messages answering it.
 *
 * The group is the unit that gets kept or dropped. Splitting one leaves a tool result answering
 * nothing, which most providers reject outright — so the failure is not "slightly worse context",
 * it is "the request errors".
 */
export function groupToolPairs(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let index = 0;

  while (index < messages.length) {
    const current = messages[index]!;

    if (current.role === 'assistant' && current.toolCalls?.length) {
      const group = [current];
      index += 1;

      // Every tool message immediately following belongs to this call.
      while (index < messages.length && messages[index]!.role === 'tool') {
        group.push(messages[index]!);
        index += 1;
      }

      groups.push(group);
      continue;
    }

    groups.push([current]);
    index += 1;
  }

  return groups;
}
