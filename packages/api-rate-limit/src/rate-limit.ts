import { z } from 'zod';
import { ApiError } from '@trustos/errors';

/**
 * Rate limits.
 *
 * A rate limit protects the *service*: it bounds how fast requests arrive so one caller cannot
 * consume the capacity everyone else needs. A quota protects the *business*: it bounds how much a
 * caller may consume over a billing period. They are separate packages here because conflating
 * them produces a specific bad outcome — a consumer who has paid for a million calls a month gets
 * refused at 3am for making forty of them in a second, and the refusal says "quota exceeded".
 *
 * The window algorithm is stated honestly rather than assumed:
 *
 * A **fixed window** is cheap and admits twice the limit across a boundary. Sixty requests at
 * 10:59:59 and sixty at 11:00:00 both pass a "sixty per minute" limit, and the service sees a
 * hundred and twenty in one second. Everybody who has implemented a fixed window has been
 * surprised by this once.
 *
 * A **sliding window** costs more state and does not have that edge. The framework defaults to
 * sliding, and `windowStrategy` says which is in use so the number in the documentation means what
 * a reader thinks it means.
 *
 * Burst is separate from rate because they answer different questions: the rate is what is
 * sustainable, the burst is what is survivable. A limit with no burst allowance refuses the
 * perfectly normal case of a client opening six parallel connections on startup.
 */

export const RATE_UNITS = ['second', 'minute', 'hour', 'day'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];

export const UNIT_MS: Record<RateUnit, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * What the limit is counted against.
 *
 * Order matters when several apply: the narrowest scope that refuses, refuses. A per-endpoint
 * limit exists precisely to stop one expensive operation consuming a consumer's whole allowance,
 * so it cannot be overridden by a more generous consumer-level limit.
 */
export const RATE_SCOPES = ['endpoint', 'consumer', 'tenant', 'api', 'global'] as const;
export type RateScope = (typeof RATE_SCOPES)[number];

const SCOPE_NARROWNESS: Record<RateScope, number> = {
  endpoint: 0,
  consumer: 1,
  tenant: 2,
  api: 3,
  global: 4,
};

export const rateLimitSchema = z
  .object({
    limitId: z.string().min(3).max(64),
    scope: z.enum(RATE_SCOPES),
    /** The API this applies to, or null for every API. */
    apiId: z.string().min(3).max(64).nullable().default(null),
    /** The operation, for endpoint scope. */
    operationId: z.string().min(3).max(120).nullable().default(null),
    /** The consumer or tenant, for those scopes. Null means the limit is a default. */
    subjectId: z.string().min(1).max(64).nullable().default(null),

    limit: z.number().int().positive().max(10_000_000),
    unit: z.enum(RATE_UNITS),

    /**
     * Requests permitted above the sustained rate, momentarily.
     *
     * Null means no allowance, which refuses a client that opens several connections at startup —
     * defensible for an expensive operation, surprising everywhere else.
     */
    burst: z.number().int().positive().max(10_000_000).nullable().default(null),

    windowStrategy: z.enum(['sliding', 'fixed']).default('sliding'),

    /**
     * What happens on breach. `shadow` counts and reports without refusing, which is how a limit
     * is introduced to an existing estate without discovering its real traffic by breaking it.
     */
    action: z.enum(['refuse', 'shadow']).default('refuse'),

    priority: z.number().int().min(0).max(1000).default(100),
    description: z.string().min(10).max(500),
  })
  .strict()
  .superRefine((limit, ctx) => {
    if (limit.scope === 'endpoint' && limit.operationId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operationId'],
        message: 'An endpoint-scoped limit names the operation it bounds.',
      });
    }

    if (limit.burst !== null && limit.burst < limit.limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['burst'],
        message:
          'A burst allowance below the sustained rate would refuse traffic the rate permits.',
      });
    }
  });

export type RateLimit = z.infer<typeof rateLimitSchema>;

export interface RateDecision {
  readonly allowed: boolean;
  /** The limit that decided, or null when none applied. */
  readonly limitId: string | null;
  readonly limit: number;
  readonly remaining: number;
  /** When the window resets — the value of the `Retry-After` header. */
  readonly resetAt: string;
  readonly retryAfterSeconds: number;
  /** True when a `shadow` limit would have refused. Counted, not enforced. */
  readonly wouldHaveRefused: boolean;
  readonly reason: string;
}

export interface RateCounterStore {
  /**
   * Count a request and return how many fall inside the window.
   *
   * Returning the count *after* incrementing is deliberate: a check-then-increment store lets two
   * concurrent requests both read the same value below the limit and both proceed, which is the
   * same class of bug as checking a balance without reserving it.
   */
  hit(key: string, at: Date, windowMs: number): Promise<{ count: number; windowStart: Date }>;
  /** Read without counting, for a usage endpoint. */
  peek(key: string, at: Date, windowMs: number): Promise<{ count: number; windowStart: Date }>;
}

/**
 * A sliding-window counter, in memory.
 *
 * Keeps timestamps rather than a bucket total, which is what makes the window slide. Production
 * deployments substitute Redis; the semantics are what this defines.
 */
export class InMemoryRateCounterStore implements RateCounterStore {
  private readonly hits = new Map<string, number[]>();

  async hit(
    key: string,
    at: Date,
    windowMs: number,
  ): Promise<{ count: number; windowStart: Date }> {
    const cutoff = at.getTime() - windowMs;
    const kept = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    kept.push(at.getTime());
    this.hits.set(key, kept);

    return { count: kept.length, windowStart: new Date(cutoff) };
  }

  async peek(
    key: string,
    at: Date,
    windowMs: number,
  ): Promise<{ count: number; windowStart: Date }> {
    const cutoff = at.getTime() - windowMs;
    const kept = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    return { count: kept.length, windowStart: new Date(cutoff) };
  }

  clear(): void {
    this.hits.clear();
  }
}

export interface RateRequest {
  readonly apiId: string;
  readonly operationId: string;
  readonly consumerId: string;
  readonly organizationId: string | null;
  readonly at: Date;
}

/** Which limits apply to a request, narrowest first. */
export function applicableLimits(limits: readonly RateLimit[], request: RateRequest): RateLimit[] {
  return limits
    .filter((limit) => {
      if (limit.apiId !== null && limit.apiId !== request.apiId) return false;
      if (limit.operationId !== null && limit.operationId !== request.operationId) return false;

      if (
        limit.scope === 'consumer' &&
        limit.subjectId !== null &&
        limit.subjectId !== request.consumerId
      ) {
        return false;
      }
      if (
        limit.scope === 'tenant' &&
        limit.subjectId !== null &&
        limit.subjectId !== request.organizationId
      ) {
        return false;
      }

      return true;
    })
    .sort(
      (left, right) =>
        SCOPE_NARROWNESS[left.scope] - SCOPE_NARROWNESS[right.scope] ||
        left.priority - right.priority,
    );
}

function counterKey(limit: RateLimit, request: RateRequest): string {
  const subject =
    limit.scope === 'consumer'
      ? request.consumerId
      : limit.scope === 'tenant'
        ? (request.organizationId ?? 'platform')
        : limit.scope === 'endpoint'
          ? `${request.consumerId}:${request.operationId}`
          : limit.scope === 'api'
            ? request.apiId
            : 'global';

  return `${limit.limitId}:${subject}`;
}

function windowStart(limit: RateLimit, at: Date): Date {
  const windowMs = UNIT_MS[limit.unit];
  return limit.windowStrategy === 'fixed'
    ? new Date(Math.floor(at.getTime() / windowMs) * windowMs)
    : new Date(at.getTime() - windowMs);
}

/**
 * Decide whether a request may proceed.
 *
 * Evaluates every applicable limit — not just the first — so the counters stay accurate. A limit
 * that stopped counting once a narrower one refused would under-count during exactly the traffic
 * it exists to measure.
 */
export async function checkRate(input: {
  limits: readonly RateLimit[];
  request: RateRequest;
  store: RateCounterStore;
}): Promise<RateDecision> {
  const applicable = applicableLimits(input.limits, input.request);

  if (applicable.length === 0) {
    return {
      allowed: true,
      limitId: null,
      limit: 0,
      remaining: 0,
      resetAt: input.request.at.toISOString(),
      retryAfterSeconds: 0,
      wouldHaveRefused: false,
      reason: 'No rate limit applies to this request.',
    };
  }

  let refusal: RateDecision | null = null;
  let shadowed = false;
  let tightest: RateDecision | null = null;

  for (const limit of applicable) {
    const windowMs = UNIT_MS[limit.unit];
    const { count } = await input.store.hit(
      counterKey(limit, input.request),
      input.request.at,
      windowMs,
    );

    const ceiling = limit.burst ?? limit.limit;
    const start = windowStart(limit, input.request.at);
    const resetAt = new Date(start.getTime() + windowMs);
    const remaining = Math.max(0, ceiling - count);

    const decision: RateDecision = {
      allowed: count <= ceiling,
      limitId: limit.limitId,
      limit: limit.limit,
      remaining,
      resetAt: resetAt.toISOString(),
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((resetAt.getTime() - input.request.at.getTime()) / 1000),
      ),
      wouldHaveRefused: false,
      reason:
        count <= ceiling
          ? `${count} of ${ceiling} per ${limit.unit}.`
          : `${limit.limit} requests per ${limit.unit} is the limit for this ${limit.scope}.`,
    };

    if (!tightest || decision.remaining < tightest.remaining) tightest = decision;

    if (count > ceiling) {
      if (limit.action === 'shadow') {
        shadowed = true;
      } else if (!refusal) {
        refusal = decision;
      }
    }
  }

  if (refusal) return { ...refusal, allowed: false, wouldHaveRefused: false };

  const allowed = tightest as RateDecision;
  return { ...allowed, allowed: true, wouldHaveRefused: shadowed };
}

export function assertWithinRate(decision: RateDecision): void {
  if (decision.allowed) return;

  throw ApiError.rateLimited(decision.reason, {
    limitId: decision.limitId,
    retryAfterSeconds: decision.retryAfterSeconds,
    resetAt: decision.resetAt,
  });
}

/**
 * The headers a rate-limited response carries.
 *
 * Returned on success as well as on refusal, which is what lets a well-behaved client slow down
 * before it is refused rather than after. A limit that only announces itself at breach time
 * teaches clients to retry rather than to pace.
 */
export function rateHeaders(decision: RateDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': decision.resetAt,
  };

  if (!decision.allowed) headers['Retry-After'] = String(decision.retryAfterSeconds);
  return headers;
}

/**
 * How much a fixed window can admit across its boundary.
 *
 * Stated as a function so the documentation cannot claim otherwise: a fixed window permits up to
 * twice its limit in an interval spanning the reset.
 */
export function fixedWindowWorstCase(limit: RateLimit): number {
  return limit.windowStrategy === 'fixed'
    ? (limit.burst ?? limit.limit) * 2
    : (limit.burst ?? limit.limit);
}
