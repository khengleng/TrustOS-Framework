import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { LoggerPort } from '@trustsystem/logging';

/**
 * Agent memory.
 *
 * What an agent remembers between turns, between sessions, and across users. Five scopes, and the
 * scope is the access-control boundary:
 *
 *   * `conversation` — this thread. Cleared when it ends.
 *   * `session`      — this sitting. Survives a page reload, not a week.
 *   * `user`         — this person, across conversations. "Prefers Khmer", "is an administrator".
 *   * `organization` — this tenant, across people. "The escalation contact is X."
 *   * `long_term`    — durable facts an agent learned and was allowed to keep.
 *
 * **Never expose another tenant's memory.** Every read takes an organization, every write records
 * one, and a user-scoped read additionally takes the user. That sounds obvious and is exactly the
 * boundary a naive implementation crosses: an agent that remembers "the customer's account number
 * is X" and recalls it for a different customer has leaked, and nothing about the recall looks
 * wrong.
 *
 * **On what should be remembered at all.** Memory is a durable record of things a model decided
 * were worth keeping, written in the model's words, with no review. That is a much lower bar than
 * anything else that gets stored, so: memories expire by default, `user` and `organization` scopes
 * are write-restricted, and a memory containing detected personal data can be refused by policy.
 */

export const MEMORY_SCOPES = [
  'conversation',
  'session',
  'user',
  'organization',
  'long_term',
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const memoryEntrySchema = z
  .object({
    id: z.string(),
    scope: z.enum(MEMORY_SCOPES),

    /** Always present. The tenant boundary. */
    organizationId: z.string().nullable(),
    /** Required for `user` scope; null otherwise. */
    userId: z.string().max(64).nullable().default(null),
    /** Required for `conversation` and `session` scope. */
    conversationId: z.string().max(64).nullable().default(null),
    sessionId: z.string().max(64).nullable().default(null),

    /** Which agent wrote it. A memory is not automatically shared between agents. */
    agentId: z.string().max(120).nullable().default(null),

    /** A short label, so a person reading the memory list can scan it. */
    key: z.string().min(1).max(200),
    /** What is remembered, in the model's words. */
    value: z.string().min(1).max(10_000),

    /**
     * How confident the agent was.
     *
     * Recorded because a memory written from an inference — "the user seems to prefer email" — is
     * weaker than one from a statement, and a recall that cannot distinguish them presents both
     * as fact.
     */
    confidence: z.enum(['stated', 'inferred']).default('inferred'),

    /**
     * When this is forgotten.
     *
     * Not nullable, and that is deliberate. A memory with no expiry is a memory nobody ever
     * revisits, written by a model, about a person. Every scope has a default, and a caller
     * wanting a permanent fact sets a long one explicitly.
     */
    expiresAt: z.coerce.date(),

    createdAt: z.coerce.date(),
    lastAccessedAt: z.coerce.date(),
    accessCount: z.number().int().min(0).default(0),
  })
  .strict();

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

/**
 * Default lifetimes per scope.
 *
 * Short for a conversation, long for organization facts. The point of the defaults is that
 * nothing lives forever by accident.
 */
export const DEFAULT_TTL_MS: Record<MemoryScope, number> = {
  conversation: 24 * 60 * 60 * 1000,
  session: 12 * 60 * 60 * 1000,
  user: 90 * 24 * 60 * 60 * 1000,
  organization: 365 * 24 * 60 * 60 * 1000,
  long_term: 365 * 24 * 60 * 60 * 1000,
};

export interface MemoryQuery {
  organizationId: string | null;
  scopes?: MemoryScope[];
  userId?: string | null;
  conversationId?: string | null;
  sessionId?: string | null;
  agentId?: string;
  /** Substring match on key or value. Not semantic — see the note on `recall`. */
  search?: string;
  limit?: number;
}

export interface MemoryStore {
  put(entry: MemoryEntry): Promise<MemoryEntry>;
  get(id: string, organizationId: string | null): Promise<MemoryEntry | null>;
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
  delete(id: string, organizationId: string | null): Promise<boolean>;
  deleteScope(input: {
    organizationId: string | null;
    scope: MemoryScope;
    conversationId?: string;
    sessionId?: string;
    userId?: string;
  }): Promise<number>;
  purgeExpired(now: Date): Promise<number>;
  /** Marks a read, for the access count and the recency ordering. */
  touch(ids: string[], now: Date): Promise<void>;
}

export const memoryPolicySchema = z
  .object({
    /**
     * Scopes an agent may write.
     *
     * Conversation and session only, by default. Writing a `user` or `organization` memory is a
     * durable claim about a person or a company, made by a model, with nobody reviewing it — so
     * it is opt-in per agent rather than available to all.
     */
    writableScopes: z.array(z.enum(MEMORY_SCOPES)).default(['conversation', 'session']),
    /** Scopes an agent may read. Broader than writable, which is the useful asymmetry. */
    readableScopes: z
      .array(z.enum(MEMORY_SCOPES))
      .default(['conversation', 'session', 'user', 'organization', 'long_term']),
    /** Most memories to recall in one turn. Memory competes with the conversation for context. */
    maxRecall: z.number().int().min(1).max(100).default(10),
    /** Most entries per scope per subject. Stops unbounded accumulation. */
    maxEntriesPerScope: z.number().int().min(1).max(1000).default(100),
    /**
     * Refuse to store a memory containing detected personal data.
     *
     * Off by default, because a support agent legitimately remembering "the customer's reference
     * is ORD-123" is the feature. On for an agent handling anything sensitive.
     */
    rejectPii: z.boolean().default(false),
  })
  .strict();

export type MemoryPolicy = z.infer<typeof memoryPolicySchema>;

export interface MemoryServiceOptions {
  store: MemoryStore;
  policy?: MemoryPolicy;
  logger?: LoggerPort;
  /** Detects personal data, when `rejectPii` is on. Wire `@trustsystem/content-filter`. */
  detectPii?: (text: string) => { found: boolean; types: string[] };
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class MemoryService {
  private readonly policy: MemoryPolicy;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: MemoryServiceOptions) {
    this.policy = options.policy ?? memoryPolicySchema.parse({});
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Stores a memory.
   *
   * Validates that the scope has the identifiers it needs — a `user` memory with no user id is a
   * memory that will be recalled for everybody in the tenant, which is the leak this package
   * exists to prevent.
   */
  async remember(input: {
    scope: MemoryScope;
    organizationId: string | null;
    userId?: string | null;
    conversationId?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    key: string;
    value: string;
    confidence?: 'stated' | 'inferred';
    ttlMs?: number;
  }): Promise<MemoryEntry> {
    if (!this.policy.writableScopes.includes(input.scope)) {
      throw ApiError.forbidden(
        `This agent may not write ${input.scope} memory. Writable scopes: ` +
          `${this.policy.writableScopes.join(', ')}. A user or organization memory is a durable ` +
          'claim about a person or a company, made by a model, with nobody reviewing it.',
        { reason: 'memory_scope_denied', scope: input.scope },
      );
    }

    this.assertScopeIdentifiers(input.scope, input);

    if (this.policy.rejectPii && this.options.detectPii) {
      const scan = this.options.detectPii(input.value);
      if (scan.found) {
        throw ApiError.validation(
          [
            {
              path: 'value',
              message:
                `This memory contains ${scan.types.join(', ')}, and this agent's policy refuses ` +
                'to store personal data in memory.',
            },
          ],
          'This memory cannot be stored.',
        );
      }
    }

    const now = this.now();
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS[input.scope];

    const entry = memoryEntrySchema.parse({
      id: this.newId('mem'),
      scope: input.scope,
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      conversationId: input.conversationId ?? null,
      sessionId: input.sessionId ?? null,
      agentId: input.agentId ?? null,
      key: input.key,
      value: input.value,
      confidence: input.confidence ?? 'inferred',
      expiresAt: new Date(now.getTime() + ttl),
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    });

    await this.enforceScopeLimit(entry);

    return this.options.store.put(entry);
  }

  /**
   * Recalls memories for a turn.
   *
   * **Substring matching, not semantic search.** That is a real limitation and it is stated rather
   * than hidden: a semantic memory search needs an embedding per memory and a vector store, which
   * is `@trustsystem/rag`'s job, and wiring it here would make memory depend on the whole retrieval
   * stack. An application that needs semantic recall stores memories as a knowledge collection.
   *
   * What this does well is what memory is mostly for: the last N things about this conversation,
   * this user and this tenant, in recency order.
   */
  async recall(input: {
    organizationId: string | null;
    userId?: string | null;
    conversationId?: string | null;
    sessionId?: string | null;
    agentId?: string;
    search?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const entries = await this.options.store.query({
      organizationId: input.organizationId,
      // Only what this agent may read, so a policy change takes effect on the next turn rather
      // than requiring a memory migration.
      scopes: this.policy.readableScopes,
      userId: input.userId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      search: input.search,
      limit: input.limit ?? this.policy.maxRecall,
    });

    const now = this.now();
    const live = entries.filter((entry) => entry.expiresAt > now);

    if (live.length > 0) {
      await this.options.store.touch(
        live.map((entry) => entry.id),
        now,
      );
    }

    return live;
  }

  /**
   * Formats memories for a prompt.
   *
   * Labelled by scope and confidence. A model given a flat list treats "the user said they prefer
   * Khmer" and "the user might prefer Khmer" identically, and then asserts the second as fact.
   */
  format(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';

    const lines = entries.map((entry) => {
      const qualifier = entry.confidence === 'inferred' ? ' (inferred, may be wrong)' : '';
      return `- [${entry.scope}] ${entry.key}: ${entry.value}${qualifier}`;
    });

    return [
      'What you remember about this context:',
      ...lines,
      '',
      'Items marked inferred were guessed rather than stated. Do not present them as fact.',
    ].join('\n');
  }

  async forget(id: string, organizationId: string | null): Promise<boolean> {
    return this.options.store.delete(id, organizationId);
  }

  /** Clears a conversation's memory. What ending a thread does. */
  async forgetConversation(conversationId: string, organizationId: string | null): Promise<number> {
    return this.options.store.deleteScope({
      organizationId,
      scope: 'conversation',
      conversationId,
    });
  }

  /**
   * Clears everything remembered about one person.
   *
   * What a data-deletion request needs. Separate from `forgetConversation` because the two are
   * different requests: ending a thread is not asking to be forgotten.
   */
  async forgetUser(userId: string, organizationId: string | null): Promise<number> {
    let removed = 0;

    for (const scope of ['user', 'long_term'] as const) {
      removed += await this.options.store.deleteScope({ organizationId, scope, userId });
    }

    this.options.logger?.info(
      { userId, organizationId, removed },
      'cleared all agent memory for a user',
    );

    return removed;
  }

  async purgeExpired(): Promise<number> {
    return this.options.store.purgeExpired(this.now());
  }

  /**
   * Keeps a scope within its entry limit, oldest first.
   *
   * Without it an agent that remembers something every turn accumulates without bound, and the
   * hundredth memory pushes the useful ones out of the recall window anyway.
   */
  private async enforceScopeLimit(entry: MemoryEntry): Promise<void> {
    const existing = await this.options.store.query({
      organizationId: entry.organizationId,
      scopes: [entry.scope],
      userId: entry.userId,
      conversationId: entry.conversationId,
      sessionId: entry.sessionId,
      limit: 1000,
    });

    if (existing.length < this.policy.maxEntriesPerScope) return;

    const excess = existing
      .sort((a, b) => a.lastAccessedAt.getTime() - b.lastAccessedAt.getTime())
      .slice(0, existing.length - this.policy.maxEntriesPerScope + 1);

    for (const stale of excess) {
      await this.options.store.delete(stale.id, stale.organizationId);
    }
  }

  /**
   * Checks a scope has the identifiers that make it scoped at all.
   *
   * The leak this prevents: a `user` memory with no user id is recalled for every user in the
   * tenant, and the recall looks entirely normal.
   */
  private assertScopeIdentifiers(
    scope: MemoryScope,
    input: { userId?: string | null; conversationId?: string | null; sessionId?: string | null },
  ): void {
    const required: Array<[MemoryScope, string, unknown]> = [
      ['conversation', 'conversationId', input.conversationId],
      ['session', 'sessionId', input.sessionId],
      ['user', 'userId', input.userId],
      ['long_term', 'userId', input.userId],
    ];

    for (const [scopeName, field, value] of required) {
      if (scope === scopeName && !value) {
        throw ApiError.validation(
          [
            {
              path: field,
              message:
                `A ${scope} memory needs a ${field}. Without one it would be recalled for every ` +
                'subject in the tenant, and nothing about the recall would look wrong.',
            },
          ],
          `This ${scope} memory is not scoped.`,
        );
      }
    }
  }
}
