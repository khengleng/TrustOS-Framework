import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LoggerPort } from '@trustsystem/logging';
import type { Message } from '@trustsystem/ai-sdk';

/**
 * AI caching.
 *
 * **The cache key is the whole problem, and it is a tenant-isolation problem.**
 *
 * A cache keyed on prompt text alone returns one tenant's answer to another tenant asking the same
 * question — and the same question is common, because most prompts are a template with a few
 * variables. That is a cross-tenant data leak with no error, no log line and no way to detect it
 * from the outside. It is the single most dangerous thing in this phase.
 *
 * So the key **always** includes the organization, and the type system makes it impossible to
 * build one without: `buildCacheKey` takes a context, not a string.
 *
 * The second rule: **caching is opt-in per request.** A default-on cache means somebody eventually
 * caches something personal. `CompletionRequest.cacheKey` is how a caller says "this answer is
 * reusable", and the absence of it means no caching.
 *
 * The third: **a cache entry is not free.** A stale answer is a wrong answer delivered
 * confidently, so entries expire, and the TTL is short by default.
 */

export const cacheEntrySchema = z
  .object({
    key: z.string(),
    organizationId: z.string().nullable(),
    /** What is cached: a completion, an embedding, or a rendered prompt. */
    kind: z.enum(['completion', 'embedding', 'prompt']),
    value: z.unknown(),
    /** For the metrics, and for a report of what caching is saving. */
    savedCostCents: z.number().min(0).default(0),
    savedTokens: z.number().int().min(0).default(0),
    createdAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
    hits: z.number().int().min(0).default(0),
  })
  .strict();

export type CacheEntry = z.infer<typeof cacheEntrySchema>;

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<boolean>;
  /**
   * Removes every entry for a tenant.
   *
   * The invalidation that actually gets used: a knowledge base changed, a prompt was republished,
   * a customer asked for their data to be removed.
   */
  deleteByOrganization(organizationId: string | null): Promise<number>;
  /** Removes entries matching a prefix. For invalidating one prompt's cached answers. */
  deleteByPrefix(prefix: string): Promise<number>;
  purgeExpired(now: Date): Promise<number>;
  size(): Promise<number>;
}

/**
 * Everything that must go into a cache key.
 *
 * A structure rather than a string, so a caller cannot build a key that omits the tenant. That
 * one type decision is what makes the cross-tenant leak structurally impossible rather than
 * merely discouraged.
 */
export interface CacheKeyInput {
  organizationId: string | null;
  kind: 'completion' | 'embedding' | 'prompt';
  /** The model, because two models give different answers to the same prompt. */
  modelId: string;
  /** The caller's own key. Usually derived from the prompt and its variables. */
  cacheKey: string;
  /** The prompt version, so republishing a prompt invalidates its cached answers. */
  promptVersion?: string;
  /** Anything else that changes the answer: temperature, tools, response format. */
  discriminators?: Record<string, string | number | boolean | null>;
}

/**
 * Builds a cache key.
 *
 * The organization is first and unconditional. `platform` for a null organization rather than an
 * empty string, so a tenant literally named `""` — which a database will happily store — cannot
 * collide with platform scope.
 */
export function buildCacheKey(input: CacheKeyInput): string {
  const material = JSON.stringify({
    org: input.organizationId ?? 'platform',
    kind: input.kind,
    model: input.modelId,
    key: input.cacheKey,
    promptVersion: input.promptVersion ?? null,
    // Sorted, so `{a:1,b:2}` and `{b:2,a:1}` are one key rather than two.
    discriminators: Object.fromEntries(
      Object.entries(input.discriminators ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });

  const hash = createHash('sha256').update(material).digest('hex');

  // The organization stays readable in the key, so `deleteByPrefix` can invalidate one tenant and
  // an operator reading the store can see whose entry is whose.
  return `ai:${input.organizationId ?? 'platform'}:${input.kind}:${hash}`;
}

/** A prompt's contribution to a cache key. Text and variables, nothing else. */
export function promptFingerprint(messages: Message[]): string {
  const material = JSON.stringify(
    messages.map((entry) => ({
      role: entry.role,
      content: entry.content,
      toolCallId: entry.toolCallId ?? null,
    })),
  );

  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export const cachePolicySchema = z
  .object({
    /** Off by default. See the header: a default-on cache eventually caches something personal. */
    enabled: z.boolean().default(false),
    /**
     * How long an entry lives, in seconds.
     *
     * Fifteen minutes. Short, because a stale AI answer is a wrong answer delivered confidently,
     * and the saving from a longer TTL is smaller than it looks — most cache value comes from
     * bursts of identical requests, which happen within seconds.
     */
    ttlSeconds: z.number().int().min(1).max(86_400).default(900),
    /** Entries above this size are not cached. A huge response is rarely worth the memory. */
    maxValueBytes: z.number().int().min(100).max(10_000_000).default(200_000),
    /**
     * Never cache a request whose prompt contains detected PII.
     *
     * On by default. A cached answer containing personal data is that data at rest in a place
     * nobody classified as storing it.
     */
    skipWhenPiiDetected: z.boolean().default(true),
  })
  .strict();

export type CachePolicy = z.infer<typeof cachePolicySchema>;

export interface CacheMetrics {
  hits: number;
  misses: number;
  /** Requests that were not even looked up, because caching was off or the request opted out. */
  skipped: number;
  writes: number;
  evictions: number;
  savedCostCents: number;
  savedTokens: number;
  hitRate: number;
}

export interface AiCacheOptions {
  store: CacheStore;
  policy?: CachePolicy;
  logger?: LoggerPort;
  now?: () => Date;
}

export class AiCache {
  private readonly policy: CachePolicy;
  private readonly now: () => Date;

  private hits = 0;
  private misses = 0;
  private skipped = 0;
  private writes = 0;
  private evictions = 0;
  private savedCostCents = 0;
  private savedTokens = 0;

  constructor(private readonly options: AiCacheOptions) {
    this.policy = options.policy ?? cachePolicySchema.parse({});
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Looks up a cached value.
   *
   * Returns null for a miss, an expired entry, or caching being off — the caller does not need to
   * distinguish, and collapsing them means one branch rather than three.
   */
  async get<T>(input: CacheKeyInput & { allowedByPolicy?: boolean }): Promise<T | null> {
    if (!this.policy.enabled || input.allowedByPolicy === false) {
      this.skipped += 1;
      return null;
    }

    const key = buildCacheKey(input);
    const entry = await this.options.store.get(key);

    if (!entry) {
      this.misses += 1;
      return null;
    }

    if (entry.expiresAt <= this.now()) {
      // Deleted on read rather than by a sweep. A stale entry read once and then removed is
      // better than one that lingers until a background job that may not be running.
      await this.options.store.delete(key);
      this.evictions += 1;
      this.misses += 1;
      return null;
    }

    /*
     * The belt-and-braces tenant check.
     *
     * The key already contains the organization, so this cannot fail unless something is very
     * wrong — a hash collision, or a store returning the wrong row. It is here because the
     * consequence of it failing silently is one tenant reading another's answer, and that is
     * worth one comparison.
     */
    if (entry.organizationId !== input.organizationId) {
      this.options.logger?.error(
        {
          key,
          expected: input.organizationId,
          found: entry.organizationId,
        },
        'cache entry organization does not match the key; discarding',
      );
      await this.options.store.delete(key);
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    this.savedCostCents += entry.savedCostCents;
    this.savedTokens += entry.savedTokens;

    await this.options.store.set({ ...entry, hits: entry.hits + 1 });

    return entry.value as T;
  }

  /**
   * Stores a value.
   *
   * Refuses when caching is off, when the request opted out, when the value is too large, or when
   * PII was detected. Each refusal is silent — a caller storing into a disabled cache has done
   * nothing wrong, and an exception would make every call site handle a case that is not an error.
   */
  async set(
    input: CacheKeyInput & {
      value: unknown;
      allowedByPolicy?: boolean;
      containsPii?: boolean;
      savedCostCents?: number;
      savedTokens?: number;
      ttlSeconds?: number;
    },
  ): Promise<boolean> {
    if (!this.policy.enabled || input.allowedByPolicy === false) return false;

    if (this.policy.skipWhenPiiDetected && input.containsPii) {
      // A cached answer containing personal data is that data at rest somewhere nobody classified
      // as storing it.
      this.options.logger?.debug(
        { organizationId: input.organizationId, kind: input.kind },
        'not caching: the content contains detected PII',
      );
      return false;
    }

    const serialized = JSON.stringify(input.value);
    if (serialized.length > this.policy.maxValueBytes) return false;

    const now = this.now();
    const ttl = input.ttlSeconds ?? this.policy.ttlSeconds;

    await this.options.store.set(
      cacheEntrySchema.parse({
        key: buildCacheKey(input),
        organizationId: input.organizationId,
        kind: input.kind,
        value: input.value,
        savedCostCents: input.savedCostCents ?? 0,
        savedTokens: input.savedTokens ?? 0,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttl * 1000),
        hits: 0,
      }),
    );

    this.writes += 1;
    return true;
  }

  /**
   * Invalidates every entry for a tenant.
   *
   * The invalidation that actually gets used, and the one that matters for a data-deletion
   * request: a customer asking to be forgotten needs their cached answers gone too.
   */
  async invalidateOrganization(organizationId: string | null): Promise<number> {
    const removed = await this.options.store.deleteByOrganization(organizationId);
    this.evictions += removed;

    this.options.logger?.info(
      { organizationId, removed },
      'invalidated cached AI results for an organization',
    );

    return removed;
  }

  /** Invalidates one tenant's entries of one kind. For a republished prompt. */
  async invalidateKind(
    organizationId: string | null,
    kind: 'completion' | 'embedding' | 'prompt',
  ): Promise<number> {
    const removed = await this.options.store.deleteByPrefix(
      `ai:${organizationId ?? 'platform'}:${kind}:`,
    );
    this.evictions += removed;
    return removed;
  }

  async purgeExpired(): Promise<number> {
    const removed = await this.options.store.purgeExpired(this.now());
    this.evictions += removed;
    return removed;
  }

  metrics(): CacheMetrics {
    const lookups = this.hits + this.misses;

    return {
      hits: this.hits,
      misses: this.misses,
      skipped: this.skipped,
      writes: this.writes,
      evictions: this.evictions,
      savedCostCents: this.savedCostCents,
      savedTokens: this.savedTokens,
      // Over lookups, not over requests: including skipped ones would make a disabled cache look
      // like a cache with a terrible hit rate.
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
    };
  }

  resetMetrics(): void {
    this.hits = 0;
    this.misses = 0;
    this.skipped = 0;
    this.writes = 0;
    this.evictions = 0;
    this.savedCostCents = 0;
    this.savedTokens = 0;
  }

  get enabled(): boolean {
    return this.policy.enabled;
  }
}

/**
 * An in-memory cache store with a bounded size.
 *
 * For tests and single-process deployments. The bound matters: an unbounded cache is a memory
 * leak with a long fuse, and AI responses are large.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 10_000) {}

  async get(key: string): Promise<CacheEntry | null> {
    return this.entries.get(key) ?? null;
  }

  async set(entry: CacheEntry): Promise<void> {
    // Oldest-first eviction. `Map` preserves insertion order, and re-inserting on a hit would
    // make this LRU — deliberately not done, because an entry that is hit constantly and never
    // expires is a stale answer that never gets re-checked.
    if (!this.entries.has(entry.key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }

    this.entries.set(entry.key, entry);
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async deleteByOrganization(organizationId: string | null): Promise<number> {
    return this.deleteByPrefix(`ai:${organizationId ?? 'platform'}:`);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;

    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  async purgeExpired(now: Date): Promise<number> {
    let removed = 0;

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  async size(): Promise<number> {
    return this.entries.size;
  }
}
