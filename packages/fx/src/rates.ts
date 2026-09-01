import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { LoggerPort } from '@trustsystem/logging';
import {
  DEFAULT_ROUNDING,
  decimal,
  divide,
  formatDecimal,
  formatMoney,
  money,
  multiply,
  parseDecimal,
  scaleTo,
  subtract,
  type CurrencyRegistry,
  type Decimal,
  type Money,
  type RoundingMode,
} from '@trustsystem/financial-core';

/**
 * Foreign exchange.
 *
 * **No live integration.** There is a `RateSource` interface and an in-memory store, and no
 * connection to a rate provider — the same rule the rest of the framework follows, and here it is
 * load-bearing for a second reason: which rate you use is a *commercial* decision. A mid-market
 * rate, a provider's rate, a rate fixed daily by a treasury team and a rate with a spread are four
 * different numbers, and a framework that picked one would be pricing somebody's product.
 *
 * Three rules the package does enforce:
 *
 *   1. **Every conversion records the rate it used**, including the source and the timestamp. A
 *      converted amount without its rate cannot be checked, reversed or explained, and "why is
 *      this 3.99 and not 4.00" is a question that gets asked months later.
 *   2. **A rate has a validity window.** Using yesterday's rate today is sometimes right and
 *      sometimes fraud; the package refuses a stale rate by default and takes the tolerance
 *      explicitly.
 *   3. **The spread is separate from the rate.** A rate with the margin baked in cannot be
 *      reconciled against the source it came from, and the margin is revenue that belongs in its
 *      own account.
 */

/** Rates carry more precision than money. A USD/KHR rate at scale 2 is useless. */
export const RATE_SCALE = 8;

export const exchangeRateSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** What is being sold. */
    fromCurrency: z.string().min(3).max(8),
    /** What is being bought. */
    toCurrency: z.string().min(3).max(8),

    /**
     * Units of `toCurrency` per one unit of `fromCurrency`, as a decimal string.
     *
     * A string, not a number: a rate of 4085.12345678 through a double is a rate that disagrees
     * with the source in the last two places, and the disagreement is multiplied by the amount.
     */
    rate: z.string(),

    /** Where it came from: `treasury`, `ecb`, `provider-x`. Recorded on every conversion. */
    source: z.string().min(1).max(120),

    /** When the rate was struck — not when the row was written. */
    quotedAt: z.coerce.date(),
    /** After this, the rate is stale and `convert` refuses it. */
    expiresAt: z.coerce.date().nullable().default(null),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
  })
  .strict()
  .superRefine((rate, ctx) => {
    if (rate.fromCurrency === rate.toCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toCurrency'],
        message:
          'A rate from a currency to itself is always 1. Storing one invites a conversion that ' +
          'applies a spread to an identity.',
      });
    }

    let parsed: Decimal;

    try {
      parsed = parseDecimal(rate.rate);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rate'],
        message: 'The rate is not a decimal.',
      });
      return;
    }

    if (parsed.units <= 0n) {
      /*
       * A zero or negative rate.
       *
       * Zero converts every amount to nothing; negative converts it to its opposite. Both post
       * cleanly and balance, which is what makes them worth refusing here rather than noticing in
       * a report.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rate'],
        message:
          `A rate of ${rate.rate} is not a rate. Zero converts every amount to nothing and a ` +
          'negative one converts it to its opposite, and both post cleanly.',
      });
    }
  });

export type ExchangeRate = z.infer<typeof exchangeRateSchema>;

/**
 * A spread, in basis points, applied against the customer.
 *
 * Basis points rather than a percentage because that is how the number is quoted and agreed — "35
 * basis points" is what a treasury team says, and converting it to 0.0035 in three places is three
 * chances to move a decimal point.
 */
export const spreadSchema = z
  .object({
    /** Hundredths of a percent. 50 is 0.5%. */
    basisPoints: z.number().int().min(0).max(10_000),
    /** Which account the margin is booked to. Revenue, and it should be visible as such. */
    revenueAccountCode: z.string().max(120).nullable().default(null),
  })
  .strict();

export type Spread = z.infer<typeof spreadSchema>;

export interface RateStore {
  put(rate: ExchangeRate): Promise<ExchangeRate>;

  /** The most recent rate at or before `asOf`, for this pair and source. */
  find(input: {
    organizationId: string | null;
    fromCurrency: string;
    toCurrency: string;
    source?: string;
    asOf?: Date;
  }): Promise<ExchangeRate | null>;

  /** Every rate for a pair in a window. For a report or an audit. */
  history(input: {
    organizationId: string | null;
    fromCurrency: string;
    toCurrency: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ExchangeRate[]>;
}

/** What a conversion produced, and everything needed to check it afterwards. */
export interface Conversion {
  from: Money;
  to: Money;

  /** The rate before any spread. */
  baseRate: string;
  /** The rate actually applied, after the spread. */
  effectiveRate: string;
  spreadBasisPoints: number;

  /** What the customer would have received at the base rate. `to` plus `spreadAmount`. */
  spreadAmount: Money;

  source: string;
  quotedAt: Date;
  convertedAt: Date;
  rateId: string;
}

export interface FxOptions {
  store: RateStore;
  currencies?: CurrencyRegistry;
  logger?: LoggerPort;
  /**
   * How old a rate may be before `convert` refuses it.
   *
   * Ten minutes by default, which is short. Using yesterday's rate today is sometimes right and
   * sometimes fraud, and the default should make somebody state which — a deployment that fixes
   * rates daily sets this to a day and has therefore decided.
   */
  maxRateAgeMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class FxService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly maxRateAgeMs: number;

  constructor(private readonly options: FxOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2)}`);
    this.maxRateAgeMs = options.maxRateAgeMs ?? 10 * 60_000;
  }

  /** Records a rate. */
  async record(input: {
    organizationId: string | null;
    fromCurrency: string;
    toCurrency: string;
    rate: string;
    source: string;
    quotedAt?: Date;
    expiresAt?: Date | null;
    metadata?: ExchangeRate['metadata'];
  }): Promise<ExchangeRate> {
    const now = this.now();

    // Both currencies must be known before a rate between them is stored, or the first conversion
    // fails on a rate somebody already agreed.
    this.options.currencies?.get(input.fromCurrency);
    this.options.currencies?.get(input.toCurrency);

    const parsed = exchangeRateSchema.safeParse({
      id: this.newId('rte'),
      organizationId: input.organizationId,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rate: input.rate,
      source: input.source,
      quotedAt: input.quotedAt ?? now,
      expiresAt: input.expiresAt ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
    });

    if (!parsed.success) {
      // An ApiError rather than a raw ZodError, so a caller handles a bad rate the same way it
      // handles every other refusal in the phase.
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'rate',
          message: issue.message,
        })),
        `This ${input.fromCurrency}/${input.toCurrency} rate is not valid.`,
      );
    }

    return this.options.store.put(parsed.data);
  }

  /**
   * Converts an amount.
   *
   * Returns the whole conversion — both amounts, both rates, the spread, the source and the
   * timestamp — rather than just the converted money. A caller that stores only the result has
   * stored a number nobody can check.
   */
  async convert(input: {
    organizationId: string | null;
    amount: Money;
    toCurrency: string;
    source?: string;
    spread?: Spread;
    asOf?: Date;
    /** Overrides the service default, for a deployment that fixes rates daily. */
    maxRateAgeMs?: number;
    rounding?: RoundingMode;
  }): Promise<Conversion> {
    const now = this.now();

    if (input.amount.currency === input.toCurrency) {
      /*
       * Converting a currency to itself.
       *
       * Refused rather than returned unchanged, because it is always a bug at the call site — and
       * the version that silently succeeds applies a spread to an identity, which is a fee charged
       * for nothing.
       */
      throw ApiError.validation(
        [
          {
            path: 'toCurrency',
            message:
              `This converts ${input.amount.currency} to itself. That is always a mistake at the ` +
              'call site, and the version that succeeds quietly charges a spread on an identity.',
          },
        ],
        'Nothing to convert.',
      );
    }

    const rate = await this.options.store.find({
      organizationId: input.organizationId,
      fromCurrency: input.amount.currency,
      toCurrency: input.toCurrency,
      source: input.source,
      asOf: input.asOf ?? now,
    });

    if (!rate) {
      throw ApiError.validation(
        [
          {
            path: 'rate',
            message:
              `No ${input.amount.currency}/${input.toCurrency} rate is available` +
              `${input.source ? ` from "${input.source}"` : ''}. The framework ships no rate ` +
              'source: which rate to use is a commercial decision, not a technical one.',
          },
        ],
        'No exchange rate.',
      );
    }

    this.assertFresh(rate, input.asOf ?? now, input.maxRateAgeMs ?? this.maxRateAgeMs);

    const baseRate = parseDecimal(rate.rate);
    const effectiveRate = applySpread(baseRate, input.spread?.basisPoints ?? 0);

    const converted = money(
      multiply(input.amount.amount, effectiveRate),
      input.toCurrency,
      this.options.currencies,
      input.rounding ?? DEFAULT_ROUNDING,
    );

    const atBase = money(
      multiply(input.amount.amount, baseRate),
      input.toCurrency,
      this.options.currencies,
      input.rounding ?? DEFAULT_ROUNDING,
    );

    return {
      from: input.amount,
      to: converted,
      baseRate: formatDecimal(baseRate),
      effectiveRate: formatDecimal(effectiveRate),
      spreadBasisPoints: input.spread?.basisPoints ?? 0,
      // What the spread cost the customer. Booked to revenue, and visible as its own number
      // rather than hidden inside a worse rate.
      spreadAmount: {
        currency: input.toCurrency,
        amount: subtract(atBase.amount, converted.amount),
      },
      source: rate.source,
      quotedAt: rate.quotedAt,
      convertedAt: now,
      rateId: rate.id,
    };
  }

  /** Every rate for a pair in a window. For an audit asking what the rate was on a date. */
  async history(input: Parameters<RateStore['history']>[0]): Promise<ExchangeRate[]> {
    return this.options.store.history(input);
  }

  /** The rate that applied at a moment, without converting anything. */
  async rateAt(input: {
    organizationId: string | null;
    fromCurrency: string;
    toCurrency: string;
    asOf: Date;
    source?: string;
  }): Promise<ExchangeRate | null> {
    return this.options.store.find(input);
  }

  /**
   * Refuses a stale rate.
   *
   * The check that stops a system quietly converting at last week's number after a rate feed
   * stops. A feed that fails silently is the common failure, and the symptom without this check
   * is a slowly widening gap that reconciliation finds a month later.
   */
  private assertFresh(rate: ExchangeRate, asOf: Date, maxAgeMs: number): void {
    if (rate.expiresAt && rate.expiresAt < asOf) {
      throw ApiError.validation(
        [
          {
            path: 'rate',
            message:
              `The ${rate.fromCurrency}/${rate.toCurrency} rate from "${rate.source}" expired at ` +
              `${rate.expiresAt.toISOString()}.`,
          },
        ],
        'The exchange rate has expired.',
      );
    }

    const ageMs = asOf.getTime() - rate.quotedAt.getTime();

    if (ageMs > maxAgeMs) {
      this.options.logger?.warn(
        { rateId: rate.id, source: rate.source, ageMs },
        'refusing a stale exchange rate',
      );

      throw ApiError.validation(
        [
          {
            path: 'rate',
            message:
              `The ${rate.fromCurrency}/${rate.toCurrency} rate from "${rate.source}" was quoted ` +
              `${Math.round(ageMs / 1000)}s ago and the limit is ${Math.round(maxAgeMs / 1000)}s. ` +
              'A rate feed that has stopped is the common failure, and converting at last week’s ' +
              'number is the symptom nobody sees until reconciliation.',
          },
        ],
        'The exchange rate is stale.',
      );
    }
  }
}

/**
 * Applies a spread against the customer.
 *
 * The customer always receives *less*, whichever direction the conversion goes — a spread that
 * sometimes favoured the customer would not be a spread. So the rate is reduced by the margin
 * rather than moved in a direction that depends on the pair.
 */
export function applySpread(rate: Decimal, basisPoints: number): Decimal {
  if (basisPoints === 0) return rate;

  const factor = subtract(decimal(10_000n, 4), decimal(BigInt(basisPoints), 4));
  return scaleTo(multiply(rate, factor), RATE_SCALE, DEFAULT_ROUNDING);
}

/**
 * The rate implied by two amounts.
 *
 * For reconciliation: a counterparty reports the two legs and not the rate, and the question is
 * whether it matches what was agreed.
 */
export function impliedRate(from: Money, to: Money): Decimal {
  if (from.amount.units === 0n) {
    throw ApiError.validation(
      [{ path: 'from', message: 'Cannot imply a rate from a zero amount.' }],
      'Cannot imply a rate.',
    );
  }

  return divide(to.amount, from.amount, RATE_SCALE);
}

/** `"100.00 USD → 409,000 KHR at 4090.00000000 (treasury)"`. For a statement or a log. */
export function describeConversion(conversion: Conversion): string {
  return (
    `${formatMoney(conversion.from)} → ${formatMoney(conversion.to)} at ` +
    `${conversion.effectiveRate} (${conversion.source}, quoted ${conversion.quotedAt.toISOString()})` +
    (conversion.spreadBasisPoints > 0
      ? `, spread ${conversion.spreadBasisPoints}bp costing ${formatMoney(conversion.spreadAmount)}`
      : '')
  );
}
