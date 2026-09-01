import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { LoggerPort } from '@trustsystem/logging';
import {
  addMoney,
  compareMoney,
  formatMoney,
  money,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustsystem/financial-core';

/**
 * The limit engine.
 *
 * A limit is a promise about what cannot happen, and the two ways to break that promise are
 * subtler than they look:
 *
 *   1. **Checking without reserving.** Two concurrent transactions each check the daily limit,
 *     each see room, and both proceed — so the limit is exceeded by exactly the amount of the
 *     second one. The engine therefore separates `check` from `consume`, and `consume` is what a
 *     caller does inside the same transaction as the movement of money.
 *   2. **Counting the wrong window.** A "daily" limit measured over a rolling 24 hours and one
 *     measured over a calendar day in the tenant's timezone give different answers at 00:30, and
 *     a customer who is refused at 00:30 and allowed at 01:00 will ask which one it is. Both are
 *     supported; the window is declared, not assumed.
 *
 * **Limits are per currency.** A 1,000 daily limit is 1,000 USD or 1,000 KHR, and those are not
 * the same promise. A limit with no currency would have to convert, and then the limit moves with
 * the exchange rate.
 */

export const LIMIT_WINDOWS = [
  /** Per transaction. No accumulation. */
  'transaction',
  /** A calendar day in the limit's timezone. Resets at local midnight. */
  'day',
  /** A calendar month in the limit's timezone. */
  'month',
  /** A rolling window of `rollingMs`. Never resets; always looks back. */
  'rolling',
] as const;

export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

export const LIMIT_SCOPES = [
  'wallet',
  'account',
  'user',
  'organization',
  /** Every actor in the tenant, together. For a platform-wide ceiling. */
  'global',
] as const;

export type LimitScope = (typeof LIMIT_SCOPES)[number];

export const limitSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** Stable and readable: `wallet.daily.usd`, `user.velocity.count`. */
    key: z.string().min(1).max(120),
    name: z.string().min(1).max(200),

    scope: z.enum(LIMIT_SCOPES),
    window: z.enum(LIMIT_WINDOWS),

    /** For `rolling`. Ignored otherwise. */
    rollingMs: z.number().int().min(1000).nullable().default(null),

    /**
     * IANA timezone for a calendar window.
     *
     * Required for `day` and `month`, because "a day" is a local idea. A platform that assumes UTC
     * refuses a customer in Phnom Penh at 07:00 local for yesterday's spending.
     */
    timezone: z.string().max(60).default('UTC'),

    currency: z.string().min(3).max(8).nullable().default(null),

    /** The ceiling on total value in the window. Null when this limit only counts. */
    maxAmount: z.string().nullable().default(null),
    /** The ceiling on the number of transactions. Null when this limit only measures value. */
    maxCount: z.number().int().min(1).nullable().default(null),

    /** Whether the limit refuses or only warns. A warn-only limit is a metric with a threshold. */
    enforcement: z.enum(['block', 'warn']).default('block'),

    enabled: z.boolean().default(true),

    /** Free-form, for grouping on a report. */
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict()
  .superRefine((limit, ctx) => {
    if (limit.maxAmount === null && limit.maxCount === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxAmount'],
        message: 'A limit needs a maximum amount or a maximum count, or it limits nothing.',
      });
    }

    if (limit.maxAmount !== null && limit.currency === null) {
      /*
       * An amount limit with no currency.
       *
       * It would have to convert to compare, and then the limit moves with the exchange rate — a
       * customer under their limit yesterday is over it today because the rate moved.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['currency'],
        message:
          'An amount limit needs a currency. Without one it would have to convert to compare, and ' +
          'the limit would then move with the exchange rate.',
      });
    }

    if (limit.window === 'rolling' && limit.rollingMs === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rollingMs'],
        message: 'A rolling window needs rollingMs.',
      });
    }
  });

export type Limit = z.infer<typeof limitSchema>;

/** What has been used against a limit, in the current window. */
export interface LimitUsage {
  limitId: string;
  subjectId: string;
  windowStart: Date;
  windowEnd: Date;
  amount: Money | null;
  count: number;
}

export interface LimitStore {
  /** The limits that apply to a subject, ordered however; the engine checks all of them. */
  applicable(input: {
    organizationId: string | null;
    scope: LimitScope;
    currency?: string;
  }): Promise<Limit[]>;

  usage(input: {
    limit: Limit;
    subjectId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<LimitUsage | null>;

  /**
   * Records consumption.
   *
   * **Must be atomic**, and must be called inside the same database transaction as the movement
   * of money. A `check` followed by an un-transacted `consume` is the race described in the
   * header: both callers see room and both proceed.
   */
  consume(input: {
    limit: Limit;
    subjectId: string;
    windowStart: Date;
    windowEnd: Date;
    amount: Money | null;
    count: number;
    idempotencyKey: string | null;
  }): Promise<LimitUsage>;

  /**
   * Whether this request has already been recorded.
   *
   * Checked *before* the ceiling check, not after. A retried transaction that re-checks first
   * fails on its own earlier consumption — it sees the money it already spent and refuses to
   * spend it again, which is the most confusing possible outcome for a caller doing exactly what
   * the retry documentation told it to.
   */
  wasConsumed(input: { organizationId: string | null; idempotencyKey: string }): Promise<boolean>;

  /** Undoes a consumption, for a transaction that failed after consuming. */
  release(input: {
    limit: Limit;
    subjectId: string;
    windowStart: Date;
    amount: Money | null;
    count: number;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface LimitViolation {
  limitId: string;
  limitKey: string;
  limitName: string;
  scope: LimitScope;
  window: LimitWindow;
  enforcement: 'block' | 'warn';
  /** Which ceiling was hit. */
  kind: 'amount' | 'count';
  /** What is used, what is allowed, what is left. */
  used: string;
  allowed: string;
  remaining: string;
  message: string;
}

export interface LimitDecision {
  allowed: boolean;
  /** Everything that would be exceeded, blocking or not. */
  violations: LimitViolation[];
  /** Warnings only. A caller may proceed and alert. */
  warnings: LimitViolation[];
  /** For a "you have X left today" message. */
  remaining: Array<{ limitKey: string; amount: Money | null; count: number | null }>;
}

export interface LimitEngineOptions {
  store: LimitStore;
  currencies?: CurrencyRegistry;
  logger?: LoggerPort;
  now?: () => Date;
}

export class LimitEngine {
  private readonly now: () => Date;

  constructor(private readonly options: LimitEngineOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Whether a movement is within every applicable limit.
   *
   * A check and nothing more. It does **not** reserve, so two concurrent callers can both pass —
   * see the header. Use it to tell somebody what they can do; use `consume` to actually do it.
   */
  async check(input: {
    organizationId: string | null;
    scope: LimitScope;
    subjectId: string;
    amount?: Money;
    count?: number;
    at?: Date;
  }): Promise<LimitDecision> {
    const at = input.at ?? this.now();

    const limits = (
      await this.options.store.applicable({
        organizationId: input.organizationId,
        scope: input.scope,
        currency: input.amount?.currency,
      })
    ).filter((limit) => limit.enabled);

    const violations: LimitViolation[] = [];
    const warnings: LimitViolation[] = [];
    const remaining: LimitDecision['remaining'] = [];

    for (const limit of limits) {
      // A limit in another currency does not apply. A 1,000 USD limit says nothing about KHR.
      if (limit.currency && input.amount && limit.currency !== input.amount.currency) continue;

      const window = windowFor(limit, at);

      const usage = await this.options.store.usage({
        limit,
        subjectId: input.subjectId,
        windowStart: window.start,
        windowEnd: window.end,
      });

      const found = this.evaluate(limit, usage, input.amount, input.count ?? 1, window);

      for (const violation of found) {
        if (violation.enforcement === 'block') violations.push(violation);
        else warnings.push(violation);
      }

      remaining.push(this.remainingFor(limit, usage));
    }

    return { allowed: violations.length === 0, violations, warnings, remaining };
  }

  /**
   * Checks and records in one step.
   *
   * The operation a caller uses when money is actually moving. Throws when a blocking limit is
   * exceeded, so the movement cannot proceed on a caller that forgot to read a boolean.
   *
   * Still not free of the race by itself: the store's `consume` must be atomic and must run in the
   * same database transaction as the posting. That is stated on the interface, and an
   * implementation that does otherwise passes every single-threaded test.
   */
  async consume(input: {
    organizationId: string | null;
    scope: LimitScope;
    subjectId: string;
    amount?: Money;
    count?: number;
    at?: Date;
    idempotencyKey?: string | null;
  }): Promise<LimitDecision> {
    if (input.idempotencyKey) {
      const already = await this.options.store.wasConsumed({
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      });

      if (already) {
        // Already counted. Report what remains without checking this movement against the ceiling
        // again — the ceiling already includes it.
        return this.check({ ...input, amount: undefined, count: 0 });
      }
    }

    const decision = await this.check(input);

    if (!decision.allowed) {
      throw ApiError.validation(
        decision.violations.map((violation) => ({
          path: 'amount',
          message: violation.message,
          code: 'limit_exceeded',
        })),
        decision.violations.length === 1
          ? `The ${decision.violations[0]!.limitName} limit would be exceeded.`
          : `${decision.violations.length} limits would be exceeded.`,
      );
    }

    const at = input.at ?? this.now();

    const limits = (
      await this.options.store.applicable({
        organizationId: input.organizationId,
        scope: input.scope,
        currency: input.amount?.currency,
      })
    ).filter((limit) => limit.enabled);

    for (const limit of limits) {
      if (limit.currency && input.amount && limit.currency !== input.amount.currency) continue;

      // Nothing to accumulate for a per-transaction ceiling; recording it would build a running
      // total that the check deliberately ignores.
      if (limit.window === 'transaction') continue;

      const window = windowFor(limit, at);

      await this.options.store.consume({
        limit,
        subjectId: input.subjectId,
        windowStart: window.start,
        windowEnd: window.end,
        amount: limit.maxAmount !== null ? (input.amount ?? null) : null,
        count: input.count ?? 1,
        idempotencyKey: input.idempotencyKey ?? null,
      });
    }

    if (decision.warnings.length > 0) {
      this.options.logger?.warn(
        {
          subjectId: input.subjectId,
          warnings: decision.warnings.map((warning) => warning.limitKey),
        },
        'limit warning threshold crossed',
      );
    }

    return decision;
  }

  /**
   * Gives back consumption for a movement that did not complete.
   *
   * Without this, a failed transaction still counts against the customer's daily limit — and the
   * customer, who was refused, is now refused again for a reason nobody can see.
   */
  async release(input: {
    organizationId: string | null;
    scope: LimitScope;
    subjectId: string;
    amount?: Money;
    count?: number;
    at?: Date;
    idempotencyKey: string;
  }): Promise<void> {
    const at = input.at ?? this.now();

    const limits = (
      await this.options.store.applicable({
        organizationId: input.organizationId,
        scope: input.scope,
        currency: input.amount?.currency,
      })
    ).filter((limit) => limit.enabled);

    for (const limit of limits) {
      if (limit.currency && input.amount && limit.currency !== input.amount.currency) continue;

      await this.options.store.release({
        limit,
        subjectId: input.subjectId,
        windowStart: windowFor(limit, at).start,
        amount: limit.maxAmount !== null ? (input.amount ?? null) : null,
        count: input.count ?? 1,
        idempotencyKey: input.idempotencyKey,
      });
    }
  }

  private evaluate(
    limit: Limit,
    usage: LimitUsage | null,
    amount: Money | undefined,
    count: number,
    window: { start: Date; end: Date },
  ): LimitViolation[] {
    const violations: LimitViolation[] = [];

    /*
     * A per-transaction limit measures this movement alone.
     *
     * Its window is an instant, so any accumulated usage against it is an artefact of two
     * movements landing on the same millisecond — and treating it as a running total turns a
     * "no single payment over 100" rule into "no more than 100 in total", which is a different
     * promise entirely.
     */
    const accumulates = limit.window !== 'transaction';

    if (limit.maxAmount !== null && amount) {
      const max = money(limit.maxAmount, limit.currency!, this.options.currencies);
      const used = accumulates
        ? (usage?.amount ?? zeroMoney(limit.currency!, this.options.currencies))
        : zeroMoney(limit.currency!, this.options.currencies);
      const after = addMoney(used, amount);

      if (compareMoney(after, max) > 0) {
        const left = subtractMoney(max, used);

        violations.push({
          limitId: limit.id,
          limitKey: limit.key,
          limitName: limit.name,
          scope: limit.scope,
          window: limit.window,
          enforcement: limit.enforcement,
          kind: 'amount',
          used: formatMoney(used),
          allowed: formatMoney(max),
          remaining: formatMoney(left),
          message:
            `${formatMoney(amount)} would take the ${limit.name} to ${formatMoney(after)}, past ` +
            `its ${formatMoney(max)} ceiling. ${formatMoney(left)} remains in this window` +
            (limit.window === 'transaction' ? '.' : `, which ends ${window.end.toISOString()}.`),
        });
      }
    }

    if (limit.maxCount !== null) {
      const used = accumulates ? (usage?.count ?? 0) : 0;
      const after = used + count;

      if (after > limit.maxCount) {
        violations.push({
          limitId: limit.id,
          limitKey: limit.key,
          limitName: limit.name,
          scope: limit.scope,
          window: limit.window,
          enforcement: limit.enforcement,
          kind: 'count',
          used: String(used),
          allowed: String(limit.maxCount),
          remaining: String(Math.max(0, limit.maxCount - used)),
          message:
            `This would be transaction ${after} against the ${limit.name} ceiling of ` +
            `${limit.maxCount}. ${Math.max(0, limit.maxCount - used)} remain in this window` +
            (limit.window === 'transaction' ? '.' : `, which ends ${window.end.toISOString()}.`),
        });
      }
    }

    return violations;
  }

  private remainingFor(limit: Limit, usage: LimitUsage | null): LimitDecision['remaining'][number] {
    const amount =
      limit.maxAmount !== null
        ? subtractMoney(
            money(limit.maxAmount, limit.currency!, this.options.currencies),
            usage?.amount ?? zeroMoney(limit.currency!, this.options.currencies),
          )
        : null;

    return {
      limitKey: limit.key,
      amount,
      count: limit.maxCount !== null ? Math.max(0, limit.maxCount - (usage?.count ?? 0)) : null,
    };
  }
}

/**
 * The window a limit is measured over, at a moment.
 *
 * Calendar windows are computed in the limit's timezone. A platform that assumes UTC refuses a
 * customer in Phnom Penh at 07:00 local for spending that, to them, happened yesterday.
 */
export function windowFor(limit: Limit, at: Date): { start: Date; end: Date } {
  switch (limit.window) {
    case 'transaction':
      // No accumulation: the window is the instant.
      return { start: at, end: at };

    case 'rolling': {
      const span = limit.rollingMs ?? 86_400_000;
      return { start: new Date(at.getTime() - span), end: at };
    }

    case 'day': {
      const parts = zonedParts(at, limit.timezone);
      const start = zonedInstant(parts.year, parts.month, parts.day, limit.timezone);
      return { start, end: new Date(start.getTime() + 86_400_000) };
    }

    case 'month': {
      const parts = zonedParts(at, limit.timezone);
      const start = zonedInstant(parts.year, parts.month, 1, limit.timezone);
      const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
      const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;

      return { start, end: zonedInstant(nextYear, nextMonth, 1, limit.timezone) };
    }
  }
}

/**
 * Cached `Intl.DateTimeFormat` instances, one per timezone.
 *
 * Constructing one costs about 40µs, and `windowFor` needs two — which made a limit check
 * dominated by date formatting rather than by anything financial. A deployment uses a handful of
 * timezones, so the map is small and permanent.
 */
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = DATE_FORMATTERS.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    DATE_FORMATTERS.set(timeZone, formatter);
  }

  return formatter;
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = OFFSET_FORMATTERS.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    OFFSET_FORMATTERS.set(timeZone, formatter);
  }

  return formatter;
}

/** Wall-clock parts in a timezone. */
function zonedParts(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = Object.fromEntries(
    dateFormatter(timeZone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

/**
 * Local midnight in a timezone, as an instant.
 *
 * Two passes: guess the offset from a UTC instant, then correct. One pass is wrong across a
 * daylight-saving boundary, and a limit window that is an hour out twice a year is a limit that
 * refuses somebody for no visible reason on two days.
 */
function zonedInstant(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = offsetAt(new Date(guess), timeZone);
  const corrected = guess - offset;

  // The offset may differ at the corrected instant; a second pass settles it.
  const secondOffset = offsetAt(new Date(corrected), timeZone);

  return new Date(guess - secondOffset);
}

function offsetAt(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    offsetFormatter(timeZone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - at.getTime();
}
