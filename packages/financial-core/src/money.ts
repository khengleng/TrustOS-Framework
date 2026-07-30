import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import {
  add,
  allocate,
  compare,
  decimal,
  divide,
  equals,
  formatDecimal,
  isNegative,
  isPositive,
  isZero,
  multiply,
  negate,
  parseDecimal,
  scaleTo,
  subtract,
  type Decimal,
  type RoundingMode,
  DEFAULT_ROUNDING,
} from './decimal';

/**
 * Money: an amount and a currency, and never one without the other.
 *
 * The single most expensive bug in financial software is adding two numbers that are in different
 * currencies. It does not throw, it does not look wrong, and the result is a number with no
 * meaning that is then written to a ledger. So there is no `Money` here that is just a number, and
 * every operation that combines two amounts checks the currency first.
 *
 * **Currencies are data, not an enum.** A framework that shipped an ISO-4217 list would ship a
 * list that is wrong for somebody: minor units differ by jurisdiction, a deployment may need a
 * loyalty point or a test currency, and the list changes. So the framework ships a *registry* and
 * a handful of well-known definitions to start from, and a deployment registers what it uses.
 */

export const currencySchema = z
  .object({
    /** ISO 4217 where one exists — `USD`, `KHR`. Uppercase letters and digits, 3 to 8 characters. */
    code: z
      .string()
      .min(3)
      .max(8)
      .regex(/^[A-Z][A-Z0-9]*$/, 'A currency code is uppercase letters and digits.'),
    name: z.string().min(1).max(80),

    /**
     * Decimal places in the currency's minor unit. 2 for USD, 0 for KHR and JPY, 3 for KWD.
     *
     * This is the scale every amount in this currency is stored at, and getting it wrong is not a
     * display bug: a KHR amount stored at scale 2 has two digits of precision the currency does
     * not have, and they will be non-zero after a percentage fee.
     */
    exponent: z.number().int().min(0).max(8),

    /** The symbol, for display only. Never parsed. */
    symbol: z.string().max(8).default(''),

    /**
     * Rounding for this currency, when a calculation has to round to its scale.
     *
     * Per currency because it is occasionally a jurisdictional requirement rather than a
     * preference — and where it is, it applies to every amount in that currency.
     */
    rounding: z
      .enum(['half_up', 'half_even', 'down', 'up', 'ceiling', 'floor'])
      .default(DEFAULT_ROUNDING),

    /** False for a point balance, a voucher or a test currency. Reported, never inferred. */
    isFiat: z.boolean().default(true),
  })
  .strict();

export type Currency = z.infer<typeof currencySchema>;

/**
 * A few well-known currencies, as a starting point.
 *
 * Deliberately short. This is not an ISO 4217 table and pretending otherwise would be worse than
 * shipping nothing — a partial list that looks complete is a list somebody trusts.
 */
export const COMMON_CURRENCIES: Currency[] = [
  {
    code: 'USD',
    name: 'United States dollar',
    exponent: 2,
    symbol: '$',
    rounding: 'half_even',
    isFiat: true,
  },
  {
    code: 'KHR',
    name: 'Cambodian riel',
    exponent: 0,
    symbol: '៛',
    rounding: 'half_even',
    isFiat: true,
  },
  { code: 'EUR', name: 'Euro', exponent: 2, symbol: '€', rounding: 'half_even', isFiat: true },
  {
    code: 'JPY',
    name: 'Japanese yen',
    exponent: 0,
    symbol: '¥',
    rounding: 'half_even',
    isFiat: true,
  },
  {
    code: 'GBP',
    name: 'Pound sterling',
    exponent: 2,
    symbol: '£',
    rounding: 'half_even',
    isFiat: true,
  },
  { code: 'THB', name: 'Thai baht', exponent: 2, symbol: '฿', rounding: 'half_even', isFiat: true },
  {
    code: 'VND',
    name: 'Vietnamese dong',
    exponent: 0,
    symbol: '₫',
    rounding: 'half_even',
    isFiat: true,
  },
  {
    code: 'SGD',
    name: 'Singapore dollar',
    exponent: 2,
    symbol: 'S$',
    rounding: 'half_even',
    isFiat: true,
  },
];

/**
 * The currencies this deployment uses.
 *
 * A registry rather than a module-level map, so two tests and two tenants cannot fight over one
 * global — and so an application that supports three currencies cannot accidentally accept a
 * fourth because it appeared in a request body.
 */
export class CurrencyRegistry {
  private readonly currencies = new Map<string, Currency>();

  constructor(currencies: unknown[] = COMMON_CURRENCIES) {
    for (const currency of currencies) this.register(currency);
  }

  register(input: unknown): Currency {
    const parsed = currencySchema.safeParse(input);

    if (!parsed.success) {
      const code = (input as { code?: string } | null)?.code ?? '(unnamed)';
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `${code}.${issue.path.join('.')}`,
          message: issue.message,
        })),
        `The currency "${code}" is not defined correctly.`,
      );
    }

    const existing = this.currencies.get(parsed.data.code);

    if (existing && existing.exponent !== parsed.data.exponent) {
      /*
       * Two definitions of one currency with different precision.
       *
       * Refused rather than last-one-wins, because every amount already stored is at the old
       * scale — and changing the scale of a currency mid-flight silently multiplies or divides
       * every balance in it by a power of ten.
       */
      throw ApiError.conflict(
        `"${parsed.data.code}" is already registered with exponent ${existing.exponent}, and this ` +
          `definition says ${parsed.data.exponent}. Every amount already stored is at the old ` +
          'scale, so accepting this would rescale every balance in the currency.',
        { reason: 'currency_conflict', code: parsed.data.code },
      );
    }

    this.currencies.set(parsed.data.code, parsed.data);
    return parsed.data;
  }

  get(code: string): Currency {
    const currency = this.currencies.get(code);

    if (!currency) {
      throw ApiError.validation(
        [
          {
            path: 'currency',
            message:
              `No currency "${code}" is registered. Registered: ${this.codes().join(', ') || '(none)'}. ` +
              'The framework ships no complete currency table on purpose — minor units vary by ' +
              'jurisdiction and a partial list that looks complete is worse than none.',
          },
        ],
        `Unknown currency "${code}".`,
      );
    }

    return currency;
  }

  has(code: string): boolean {
    return this.currencies.has(code);
  }

  codes(): string[] {
    return [...this.currencies.keys()].sort();
  }

  list(): Currency[] {
    return this.codes().map((code) => this.currencies.get(code)!);
  }
}

/** The default registry, for an application that has not configured one. */
export const DEFAULT_CURRENCIES = new CurrencyRegistry();

export interface Money {
  readonly currency: string;
  readonly amount: Decimal;
}

/**
 * Builds money at the currency's own scale.
 *
 * Always scales to the currency's exponent, so a USD amount is always scale 2 and a KHR amount is
 * always scale 0. Two amounts in one currency are therefore always directly comparable, and an
 * amount cannot carry precision the currency does not have.
 */
export function money(
  amount: string | number | bigint | Decimal,
  currencyCode: string,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
  mode?: RoundingMode,
): Money {
  const currency = registry.get(currencyCode);

  const parsed = typeof amount === 'object' && 'units' in amount ? amount : parseDecimal(amount);

  return {
    currency: currency.code,
    amount: scaleTo(parsed, currency.exponent, mode ?? currency.rounding),
  };
}

/** Money from minor units — 1234 cents is $12.34. What a provider API usually sends. */
export function fromMinorUnits(
  units: bigint | number,
  currencyCode: string,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
): Money {
  const currency = registry.get(currencyCode);

  return {
    currency: currency.code,
    amount: decimal(BigInt(units), currency.exponent),
  };
}

/** The minor units. What a provider API usually wants back. */
export function toMinorUnits(value: Money): bigint {
  return value.amount.units;
}

export function zeroMoney(
  currencyCode: string,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
): Money {
  return fromMinorUnits(0n, currencyCode, registry);
}

/**
 * Refuses two amounts in different currencies.
 *
 * The check that prevents the most expensive bug in the phase. It throws rather than returning a
 * result, because there is no sensible value to return and a caller that ignored a boolean would
 * write the meaningless sum to a ledger.
 */
export function assertSameCurrency(left: Money, right: Money, operation = 'this operation'): void {
  if (left.currency !== right.currency) {
    throw ApiError.validation(
      [
        {
          path: 'currency',
          message:
            `Cannot perform ${operation} on ${left.currency} and ${right.currency}. Converting ` +
            'between them needs an exchange rate, a timestamp and a spread — see @trustos/fx.',
        },
      ],
      'Currency mismatch.',
    );
  }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right, 'addition');
  return { currency: left.currency, amount: add(left.amount, right.amount) };
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right, 'subtraction');
  return { currency: left.currency, amount: subtract(left.amount, right.amount) };
}

export function negateMoney(value: Money): Money {
  return { currency: value.currency, amount: negate(value.amount) };
}

/**
 * Multiplies money by a plain factor — a rate, a percentage, a quantity.
 *
 * Rounds to the currency's scale, because the result is money and money has the currency's
 * precision. The intermediate product is exact; only the final scaling rounds.
 */
export function multiplyMoney(
  value: Money,
  factor: Decimal,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
  mode?: RoundingMode,
): Money {
  const currency = registry.get(value.currency);
  const product = multiply(value.amount, factor);

  return {
    currency: value.currency,
    amount: scaleTo(product, currency.exponent, mode ?? currency.rounding),
  };
}

export function divideMoney(
  value: Money,
  divisor: Decimal,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
  mode?: RoundingMode,
): Money {
  const currency = registry.get(value.currency);

  return {
    currency: value.currency,
    amount: divide(value.amount, divisor, currency.exponent, mode ?? currency.rounding),
  };
}

/**
 * Splits money into parts that sum to exactly the original.
 *
 * $100 three ways is 33.34, 33.33, 33.33 — not 33.33 three times, which loses a cent. See
 * `allocate` in `decimal.ts` for why the extra unit goes where it does.
 */
export function allocateMoney(value: Money, weights: number[]): Money[] {
  return allocate(value.amount, weights).map((amount) => ({ currency: value.currency, amount }));
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right, 'comparison');
  return compare(left.amount, right.amount);
}

export function moneyEquals(left: Money, right: Money): boolean {
  return left.currency === right.currency && equals(left.amount, right.amount);
}

export function isZeroMoney(value: Money): boolean {
  return isZero(value.amount);
}

export function isNegativeMoney(value: Money): boolean {
  return isNegative(value.amount);
}

export function isPositiveMoney(value: Money): boolean {
  return isPositive(value.amount);
}

export function minMoney(left: Money, right: Money): Money {
  return compareMoney(left, right) <= 0 ? left : right;
}

export function maxMoney(left: Money, right: Money): Money {
  return compareMoney(left, right) >= 0 ? left : right;
}

/**
 * Sums a list.
 *
 * Takes the currency explicitly rather than reading it from the first element, so an empty list
 * has an answer and a list that accidentally mixes currencies is refused rather than silently
 * adopting whatever came first.
 */
export function sumMoney(
  values: Money[],
  currencyCode: string,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
): Money {
  return values.reduce<Money>(
    (total, value) => addMoney(total, value),
    zeroMoney(currencyCode, registry),
  );
}

/** `"12.34 USD"`. Unambiguous, sortable per currency, and never locale-dependent. */
export function formatMoney(value: Money): string {
  return `${formatDecimal(value.amount)} ${value.currency}`;
}

/** With the symbol, for a user interface. Never parsed back. */
export function displayMoney(
  value: Money,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
): string {
  const currency = registry.get(value.currency);
  const symbol = currency.symbol || `${currency.code} `;

  return isNegative(value.amount)
    ? `-${symbol}${formatDecimal(negate(value.amount))}`
    : `${symbol}${formatDecimal(value.amount)}`;
}

/** Parses `"12.34 USD"`. The inverse of `formatMoney`, for a stored or transmitted value. */
export function parseMoney(input: string, registry: CurrencyRegistry = DEFAULT_CURRENCIES): Money {
  const match = /^\s*(-?[\d._]+(?:\.\d+)?)\s+([A-Z][A-Z0-9]{2,7})\s*$/.exec(input);

  if (!match) {
    throw ApiError.validation(
      [{ path: 'money', message: `"${input}" is not money. Expected "12.34 USD".` }],
      'Invalid money.',
    );
  }

  return money(match[1]!, match[2]!, registry);
}

/** The JSON shape: a string amount, never a number. See the header of `decimal.ts`. */
export const moneySchema = z
  .object({
    currency: z.string().min(3).max(8),
    /** A string. A JSON number here would go through a double on the way in. */
    amount: z.string(),
  })
  .strict();

export function moneyToJson(value: Money): z.infer<typeof moneySchema> {
  return { currency: value.currency, amount: formatDecimal(value.amount) };
}

export function moneyFromJson(
  input: unknown,
  registry: CurrencyRegistry = DEFAULT_CURRENCIES,
): Money {
  const parsed = moneySchema.parse(input);
  return money(parsed.amount, parsed.currency, registry);
}
