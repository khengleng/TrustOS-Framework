import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * Quotas.
 *
 * A quota is a commercial boundary, not a capacity one — see `@trustsystem/api-rate-limit` for the
 * other half and why they are separate.
 *
 * Two decisions shape this package, and both come from the same observation: a quota that refuses
 * a caller mid-month costs somebody money, so the arithmetic has to be defensible to a customer
 * reading an invoice.
 *
 * **Usage is reported, never inferred.** The consumption a quota counts is recorded per request
 * against a stated period. Nothing here samples, extrapolates or estimates — a quota that says
 * "approximately 840,000 calls" cannot be reconciled with a bill, and the first dispute makes that
 * everyone's problem.
 *
 * **The period is a calendar period, anchored to a stated day.** Not a rolling thirty days: a
 * consumer whose plan renews on the 15th expects their quota to reset on the 15th, and a rolling
 * window means it never resets — it just gradually forgets, which is impossible to explain.
 *
 * Overage is a policy, not an accident. `hard` refuses, `soft` permits and records, `billable`
 * permits and prices. All three are legitimate and the difference is commercial, so it is declared
 * rather than decided by whoever writes the check.
 */

export const QUOTA_PERIODS = ['daily', 'monthly', 'annual'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export const QUOTA_SCOPES = ['consumer', 'tenant', 'plan', 'product'] as const;
export type QuotaScope = (typeof QUOTA_SCOPES)[number];

export const quotaSchema = z
  .object({
    quotaId: z.string().min(3).max(64),
    scope: z.enum(QUOTA_SCOPES),
    subjectId: z.string().min(1).max(64),
    /** The API this quota counts, or null for every call the subject makes. */
    apiId: z.string().min(3).max(64).nullable().default(null),

    period: z.enum(QUOTA_PERIODS),
    /**
     * The day of the month a monthly period resets on, 1..28.
     *
     * Capped at 28 deliberately: a quota anchored to the 31st would reset in seven months of the
     * year and drift in the other five, and a consumer cannot be told which.
     */
    resetDayOfMonth: z.number().int().min(1).max(28).default(1),

    /** Calls permitted in a period. */
    limit: z.number().int().positive().max(1_000_000_000),

    /**
     * What happens past the limit.
     *
     * `hard` refuses. `soft` permits and records, for a consumer whose contract does not cap them.
     * `billable` permits and prices the excess.
     */
    overage: z.enum(['hard', 'soft', 'billable']).default('hard'),

    /**
     * Price per call past the limit, in minor units as a string.
     *
     * A string because it is money, and money never floats — the framework rule, and the reason a
     * billing dispute over a quota is arithmetic rather than an argument about rounding.
     */
    overageUnitPrice: z
      .string()
      .regex(/^\d{1,15}$/, 'Minor units, as digits. Money is never a float.')
      .nullable()
      .default(null),
    overageCurrency: z.string().length(3).nullable().default(null),

    /** Fractions of the quota at which the consumer is told. */
    alertThresholds: z.array(z.number().min(0).max(1)).default([0.8, 0.95]),

    description: z.string().min(10).max(500),
  })
  .strict()
  .superRefine((quota, ctx) => {
    if (
      quota.overage === 'billable' &&
      (quota.overageUnitPrice === null || quota.overageCurrency === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overageUnitPrice'],
        message: 'A billable overage states its price and currency, or nobody can invoice it.',
      });
    }

    if (quota.overage !== 'billable' && quota.overageUnitPrice !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overageUnitPrice'],
        message:
          'A price on a non-billable overage is a price nothing charges. Say which is intended.',
      });
    }
  });

export type Quota = z.infer<typeof quotaSchema>;

export interface QuotaPeriodWindow {
  readonly start: Date;
  readonly end: Date;
  /** The identifier a usage record is filed under, e.g. `2026-06`. */
  readonly key: string;
}

/**
 * The period a moment falls into.
 *
 * A calendar period anchored to the reset day, so a consumer whose plan renews on the 15th sees
 * their quota reset on the 15th. Computed in UTC — a quota that resets at local midnight resets
 * twice a year for a consumer whose region observes daylight saving.
 */
export function periodFor(quota: Quota, at: Date): QuotaPeriodWindow {
  if (quota.period === 'daily') {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const end = new Date(start.getTime() + 86_400_000);
    return { start, end, key: start.toISOString().slice(0, 10) };
  }

  if (quota.period === 'annual') {
    const year =
      at.getUTCMonth() === 0 && at.getUTCDate() < quota.resetDayOfMonth
        ? at.getUTCFullYear() - 1
        : at.getUTCFullYear();
    const start = new Date(Date.UTC(year, 0, quota.resetDayOfMonth));
    const end = new Date(Date.UTC(year + 1, 0, quota.resetDayOfMonth));
    return { start, end, key: String(year) };
  }

  const beforeReset = at.getUTCDate() < quota.resetDayOfMonth;
  const month = beforeReset ? at.getUTCMonth() - 1 : at.getUTCMonth();
  const start = new Date(Date.UTC(at.getUTCFullYear(), month, quota.resetDayOfMonth));
  const end = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, quota.resetDayOfMonth),
  );

  return { start, end, key: start.toISOString().slice(0, 7) };
}

export interface QuotaUsage {
  readonly quotaId: string;
  readonly periodKey: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  /** Calls past the limit. Zero unless overage is permitted. */
  readonly overageCalls: number;
  /** Cost of the overage in minor units, as a string. Null when nothing is billable. */
  readonly overageCost: string | null;
  readonly currency: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Fraction consumed. Above 1 when in overage. */
  readonly consumed: number;
}

export interface QuotaUsageStore {
  /** Count one call and return the new total for the period. */
  consume(quotaId: string, periodKey: string, calls: number): Promise<number>;
  /** Read without counting. */
  read(quotaId: string, periodKey: string): Promise<number>;
}

export class InMemoryQuotaUsageStore implements QuotaUsageStore {
  private readonly totals = new Map<string, number>();

  private static key(quotaId: string, periodKey: string): string {
    return `${quotaId}:${periodKey}`;
  }

  async consume(quotaId: string, periodKey: string, calls: number): Promise<number> {
    const key = InMemoryQuotaUsageStore.key(quotaId, periodKey);
    const total = (this.totals.get(key) ?? 0) + calls;
    this.totals.set(key, total);
    return total;
  }

  async read(quotaId: string, periodKey: string): Promise<number> {
    return this.totals.get(InMemoryQuotaUsageStore.key(quotaId, periodKey)) ?? 0;
  }
}

function usageFrom(quota: Quota, window: QuotaPeriodWindow, used: number): QuotaUsage {
  const overageCalls = Math.max(0, used - quota.limit);

  const overageCost =
    quota.overage === 'billable' && quota.overageUnitPrice !== null
      ? (BigInt(quota.overageUnitPrice) * BigInt(overageCalls)).toString()
      : null;

  return {
    quotaId: quota.quotaId,
    periodKey: window.key,
    used,
    limit: quota.limit,
    remaining: Math.max(0, quota.limit - used),
    overageCalls,
    overageCost,
    currency: quota.overageCurrency,
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
    consumed: Number((used / quota.limit).toFixed(6)),
  };
}

export interface QuotaDecision {
  readonly allowed: boolean;
  readonly usage: QuotaUsage;
  readonly reason: string;
  /** Thresholds crossed by this call, for notification. */
  readonly crossedThresholds: readonly number[];
  readonly inOverage: boolean;
}

/**
 * Consume from a quota and decide.
 *
 * Counting happens before deciding, as in the rate limiter and for the same reason: a
 * read-then-write leaves two concurrent calls both seeing room.
 *
 * A `soft` or `billable` quota returns `allowed: true` past its limit, and says so through
 * `inOverage`. Reporting that as a plain success would leave nothing to bill and nothing to
 * escalate.
 */
export async function consumeQuota(input: {
  quota: Quota;
  store: QuotaUsageStore;
  at: Date;
  calls?: number;
}): Promise<QuotaDecision> {
  const calls = input.calls ?? 1;
  const window = periodFor(input.quota, input.at);

  const before = await input.store.read(input.quota.quotaId, window.key);
  const after = await input.store.consume(input.quota.quotaId, window.key, calls);

  const usage = usageFrom(input.quota, window, after);
  const inOverage = after > input.quota.limit;

  const crossedThresholds = input.quota.alertThresholds.filter((threshold) => {
    const mark = input.quota.limit * threshold;
    return before < mark && after >= mark;
  });

  if (inOverage && input.quota.overage === 'hard') {
    return {
      allowed: false,
      usage,
      reason: `The ${input.quota.period} quota of ${input.quota.limit} calls is exhausted until ${usage.periodEnd}.`,
      crossedThresholds,
      inOverage,
    };
  }

  return {
    allowed: true,
    usage,
    reason: inOverage
      ? `Past the ${input.quota.period} quota by ${usage.overageCalls} call(s); ${input.quota.overage} overage applies.`
      : `${usage.used} of ${input.quota.limit} used this period.`,
    crossedThresholds,
    inOverage,
  };
}

/** Read usage without consuming — what a usage endpoint returns. */
export async function readQuota(input: {
  quota: Quota;
  store: QuotaUsageStore;
  at: Date;
}): Promise<QuotaUsage> {
  const window = periodFor(input.quota, input.at);
  return usageFrom(input.quota, window, await input.store.read(input.quota.quotaId, window.key));
}

export function assertWithinQuota(decision: QuotaDecision): void {
  if (decision.allowed) return;

  throw ApiError.rateLimited(decision.reason, {
    reason: 'quota_exhausted',
    quotaId: decision.usage.quotaId,
    periodEnd: decision.usage.periodEnd,
    limit: decision.usage.limit,
  });
}

/**
 * Quota headers.
 *
 * Distinct names from the rate-limit headers, because a client that cannot tell which boundary it
 * is approaching cannot respond to either: slowing down does not help an exhausted quota, and
 * buying more quota does not help a breached rate limit.
 */
export function quotaHeaders(usage: QuotaUsage): Record<string, string> {
  return {
    'Quota-Limit': String(usage.limit),
    'Quota-Remaining': String(usage.remaining),
    'Quota-Reset': usage.periodEnd,
    'Quota-Period': usage.periodKey,
  };
}

/**
 * What the overage costs, in minor units.
 *
 * Exposed separately from the decision so a billing run can price a period without replaying its
 * traffic. `BigInt` throughout: a month of overage at a sub-cent unit price is exactly where a
 * float loses a digit, and the number is on somebody's invoice.
 */
export function overageCost(
  quota: Quota,
  calls: number,
): { amount: string; currency: string } | null {
  if (
    quota.overage !== 'billable' ||
    quota.overageUnitPrice === null ||
    quota.overageCurrency === null
  ) {
    return null;
  }

  const excess = Math.max(0, calls - quota.limit);
  return {
    amount: (BigInt(quota.overageUnitPrice) * BigInt(excess)).toString(),
    currency: quota.overageCurrency,
  };
}
