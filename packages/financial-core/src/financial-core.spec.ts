import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustos/errors';
import {
  add,
  allocate,
  compare,
  decimal,
  divide,
  formatDecimal,
  multiply,
  parseDecimal,
  scaleTo,
  subtract,
  sum,
  unsafeToNumber,
  zero,
} from './decimal';
import {
  CurrencyRegistry,
  addMoney,
  allocateMoney,
  compareMoney,
  displayMoney,
  formatMoney,
  fromMinorUnits,
  money,
  moneyFromJson,
  moneyToJson,
  multiplyMoney,
  parseMoney,
  subtractMoney,
  sumMoney,
  toMinorUnits,
  zeroMoney,
} from './money';
import {
  assertFinancialId,
  idempotencyKey,
  isFinancialId,
  isTerminal,
  newFinancialId,
  newReference,
  referenceSchema,
} from './identifiers';

/**
 * The accuracy tests are the point of this file.
 *
 * Every one of them is a calculation that a floating-point implementation gets wrong — not
 * dramatically wrong, which somebody would notice, but wrong in a place that survives every
 * assertion until it reaches reconciliation.
 */

const d = (value: string) => parseDecimal(value);

/**
 * The messages, not the summary.
 *
 * `ApiError.validation` carries a one-line summary and a list of details, and `toThrow(/…/)` only
 * matches the summary. The reasoning is in the details, so that is what these assert on.
 */
function detailsOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const details = (error as { details?: Array<{ message: string }> }).details ?? [];
    return details.map((detail) => detail.message).join(' | ') || (error as Error).message;
  }

  throw new Error('Expected a throw and got none.');
}

describe('the arithmetic floating point gets wrong', () => {
  it('adds a tenth and two tenths to exactly three tenths', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in a double.
    expect(formatDecimal(add(d('0.1'), d('0.2')))).toBe('0.3');
  });

  it('subtracts without leaving a residue', () => {
    // 1.005 - 1 === 0.004999999999999893 in a double.
    expect(formatDecimal(subtract(d('1.005'), d('1')))).toBe('0.005');
  });

  it('multiplies a percentage exactly', () => {
    // 1234.56 * 0.025 === 30.863999999999997 in a double, which rounds to 30.86.
    // Exactly, it is 30.864, which rounds to 30.86 as well — but only because half_even and the
    // digit after are both in our favour. The exact value is what the counterparty computed.
    expect(formatDecimal(multiply(d('1234.56'), d('0.025')))).toBe('30.86400');
  });

  it('sums a hundred tenths to exactly ten', () => {
    // Adding 0.1 a hundred times in a double gives 9.99999999999998.
    const values = Array.from({ length: 100 }, () => d('0.1'));
    expect(formatDecimal(sum(values, 1))).toBe('10.0');
  });

  it('handles amounts beyond a double’s integer precision', () => {
    // 2^53 + 1 is not representable as a double. A national-currency balance in minor units
    // reaches this: 9 quadrillion riel is not an absurd number for a system total.
    const big = decimal(9_007_199_254_740_993n, 0);
    expect(formatDecimal(add(big, decimal(1n, 0)))).toBe('9007199254740994');
  });
});

describe('parsing', () => {
  it('keeps the scale the string declared', () => {
    // "1.50" is a price with two decimal places. "1.5" is a number with one.
    expect(parseDecimal('1.50').scale).toBe(2);
    expect(parseDecimal('1.5').scale).toBe(1);
    expect(compare(parseDecimal('1.50'), parseDecimal('1.5'))).toBe(0);
  });

  it('accepts a sign, underscores and a bare integer', () => {
    expect(formatDecimal(parseDecimal('-12.34'))).toBe('-12.34');
    expect(formatDecimal(parseDecimal('+0.5'))).toBe('0.5');
    expect(formatDecimal(parseDecimal('1_000_000'))).toBe('1000000');
  });

  it('rejects exponent notation', () => {
    /*
     * A number written 1e3 in a financial file has usually been through a float already, so
     * accepting it would hide the conversion that already happened.
     */
    expect(() => parseDecimal('1e3')).toThrow(ApiError);
    expect(() => parseDecimal('1E-3')).toThrow(ApiError);
  });

  it('rejects the things a permissive parser accepts', () => {
    for (const bad of ['', '  ', 'NaN', 'Infinity', '12.34.56', '1,234.56', '$1.00', '--1']) {
      expect(() => parseDecimal(bad), bad).toThrow(ApiError);
    }
  });

  it('refuses a non-integer JavaScript number', () => {
    // parseDecimal(0.1) would have to decide what 0.1 means, and the honest answer is
    // 0.1000000000000000055511151231257827.
    expect(detailsOf(() => parseDecimal(0.1))).toMatch(/not a safe integer/);
    expect(formatDecimal(parseDecimal(42))).toBe('42');
  });

  it('refuses more places than it can hold', () => {
    expect(detailsOf(() => parseDecimal('0.1234567890123456789'))).toMatch(/decimal places/);
  });
});

describe('rounding', () => {
  const at = (value: string, mode: Parameters<typeof scaleTo>[2]) =>
    formatDecimal(scaleTo(d(value), 2, mode));

  it('rounds half to even by default, which is what stops the drift', () => {
    /*
     * half_up adds half a minor unit of positive bias per tie. Over a million fee calculations
     * that is a real number sitting in a suspense account that nobody can account for.
     */
    expect(at('1.005', 'half_even')).toBe('1.00');
    expect(at('1.015', 'half_even')).toBe('1.02');
    expect(at('1.025', 'half_even')).toBe('1.02');
    expect(at('1.035', 'half_even')).toBe('1.04');
  });

  it('rounds half away from zero when asked', () => {
    expect(at('1.005', 'half_up')).toBe('1.01');
    expect(at('-1.005', 'half_up')).toBe('-1.01');
  });

  it('truncates toward zero on both sides', () => {
    expect(at('1.999', 'down')).toBe('1.99');
    expect(at('-1.999', 'down')).toBe('-1.99');
  });

  it('rounds away from zero on both sides', () => {
    expect(at('1.001', 'up')).toBe('1.01');
    expect(at('-1.001', 'up')).toBe('-1.01');
  });

  it('distinguishes ceiling from up, and floor from down, for negatives', () => {
    // The distinction only shows on the negative side, which is where it is always got wrong.
    expect(at('-1.001', 'ceiling')).toBe('-1.00');
    expect(at('-1.001', 'floor')).toBe('-1.01');
  });

  it('does not round when nothing is lost', () => {
    expect(formatDecimal(scaleTo(d('1.5'), 4))).toBe('1.5000');
  });
});

describe('division', () => {
  it('requires a scale and rounds once', () => {
    expect(formatDecimal(divide(d('10'), d('3'), 4))).toBe('3.3333');
    expect(formatDecimal(divide(d('2'), d('3'), 4))).toBe('0.6667');
  });

  it('is exact when it divides evenly', () => {
    expect(formatDecimal(divide(d('10'), d('4'), 2))).toBe('2.50');
  });

  it('refuses to divide by zero rather than producing Infinity', () => {
    expect(() => divide(d('1'), zero(2), 2)).toThrow(ApiError);
    expect(detailsOf(() => divide(d('1'), zero(2), 2))).toMatch(/Division by zero/);
  });
});

describe('allocation', () => {
  it('splits a hundred three ways without losing a cent', () => {
    // The classic: 33.33 three times is 99.99. The cent has to go somewhere.
    const parts = allocate(parseDecimal('100.00'), [1, 1, 1]);

    expect(parts.map(formatDecimal)).toEqual(['33.34', '33.33', '33.33']);
    expect(formatDecimal(sum(parts, 2))).toBe('100.00');
  });

  it('splits by weight and still sums exactly', () => {
    const parts = allocate(parseDecimal('100.00'), [70, 20, 10]);

    expect(parts.map(formatDecimal)).toEqual(['70.00', '20.00', '10.00']);
    expect(formatDecimal(sum(parts, 2))).toBe('100.00');
  });

  it('gives the odd unit to the largest share, deterministically', () => {
    // Deterministic matters: two systems computing the split independently have to agree.
    const first = allocate(parseDecimal('0.05'), [3, 2, 1]);
    const second = allocate(parseDecimal('0.05'), [3, 2, 1]);

    expect(first.map(formatDecimal)).toEqual(second.map(formatDecimal));
    expect(formatDecimal(sum(first, 2))).toBe('0.05');
  });

  it('allocates a negative amount without losing a unit either', () => {
    const parts = allocate(parseDecimal('-100.00'), [1, 1, 1]);

    expect(formatDecimal(sum(parts, 2))).toBe('-100.00');
  });

  it('refuses weights that cannot describe a split', () => {
    expect(detailsOf(() => allocate(parseDecimal('1.00'), []))).toMatch(/at least one weight/);
    expect(detailsOf(() => allocate(parseDecimal('1.00'), [0, 0]))).toMatch(/sum to zero/);
    expect(detailsOf(() => allocate(parseDecimal('1.00'), [1, -1]))).toMatch(/negative weight/);
  });
});

describe('formatting', () => {
  it('shows every place the scale declares', () => {
    // A price that renders as "1.5" one day and "1.50" the next is a price somebody compares as
    // a string.
    expect(formatDecimal(decimal(150n, 2))).toBe('1.50');
    expect(formatDecimal(decimal(5n, 3))).toBe('0.005');
    expect(formatDecimal(decimal(-5n, 3))).toBe('-0.005');
    expect(formatDecimal(decimal(0n, 2))).toBe('0.00');
  });

  it('round-trips through its own string form', () => {
    for (const text of ['0.00', '-0.01', '1234567.89', '999999999999.999']) {
      expect(formatDecimal(parseDecimal(text))).toBe(text);
    }
  });

  it('names the unsafe conversion in the function it lives in', () => {
    expect(unsafeToNumber(d('1.25'))).toBe(1.25);
  });
});

describe('currency', () => {
  const registry = new CurrencyRegistry();

  it('stores an amount at the currency’s own scale', () => {
    // KHR has no minor unit. An amount carrying two decimal places has precision the currency
    // does not have, and they will be non-zero after a percentage fee.
    expect(formatMoney(money('1.005', 'USD', registry))).toBe('1.00 USD');
    expect(formatMoney(money('1234.5', 'KHR', registry))).toBe('1234 KHR');
  });

  it('refuses an unknown currency and says what is registered', () => {
    expect(() => money('1', 'XYZ', registry)).toThrow(/Unknown currency "XYZ"/);
    expect(detailsOf(() => money('1', 'XYZ', registry))).toMatch(
      /partial list that looks complete/,
    );
  });

  it('refuses to redefine a currency’s precision', () => {
    /*
     * Every amount already stored is at the old scale, so accepting this would multiply or divide
     * every balance in the currency by a power of ten.
     */
    const own = new CurrencyRegistry();

    expect(() => own.register({ code: 'USD', name: 'United States dollar', exponent: 3 })).toThrow(
      /already registered with exponent 2/,
    );
  });

  it('accepts an identical redefinition, so a double registration is not an outage', () => {
    const own = new CurrencyRegistry();

    expect(() =>
      own.register({ code: 'USD', name: 'United States dollar', exponent: 2, symbol: '$' }),
    ).not.toThrow();
  });

  it('supports a non-fiat balance', () => {
    const own = new CurrencyRegistry([]);
    own.register({ code: 'POINTS', name: 'Loyalty points', exponent: 0, isFiat: false });

    expect(formatMoney(money('500', 'POINTS', own))).toBe('500 POINTS');
  });
});

describe('money', () => {
  const registry = new CurrencyRegistry();

  it('refuses to add two currencies', () => {
    // The single most expensive bug in financial software: it does not throw, does not look
    // wrong, and writes a meaningless number to a ledger.
    expect(
      detailsOf(() => addMoney(money('1', 'USD', registry), money('1', 'KHR', registry))),
    ).toMatch(/Cannot perform addition on USD and KHR/);
  });

  it('refuses to compare two currencies', () => {
    expect(
      detailsOf(() => compareMoney(money('1', 'USD', registry), money('1', 'EUR', registry))),
    ).toMatch(/Cannot perform comparison/);
  });

  it('points at the FX package rather than just refusing', () => {
    expect(
      detailsOf(() => subtractMoney(money('1', 'USD', registry), money('1', 'EUR', registry))),
    ).toMatch(/@trustos\/fx/);
  });

  it('converts to and from minor units without going through a float', () => {
    expect(toMinorUnits(money('12.34', 'USD', registry))).toBe(1234n);
    expect(formatMoney(fromMinorUnits(1234n, 'USD', registry))).toBe('12.34 USD');
    expect(toMinorUnits(money('1234', 'KHR', registry))).toBe(1234n);
  });

  it('rounds a percentage to the currency’s scale', () => {
    const fee = multiplyMoney(money('1234.56', 'USD', registry), d('0.025'), registry);

    expect(formatMoney(fee)).toBe('30.86 USD');
  });

  it('sums an empty list to zero rather than throwing', () => {
    // A period with no transactions has a balance of zero, not an error.
    expect(formatMoney(sumMoney([], 'USD', registry))).toBe('0.00 USD');
  });

  it('takes the currency for a sum explicitly, so a mixed list is refused', () => {
    expect(
      detailsOf(() =>
        sumMoney([money('1', 'USD', registry), money('1', 'EUR', registry)], 'USD', registry),
      ),
    ).toMatch(/Cannot perform addition/);
  });

  it('splits money so the parts sum to the original', () => {
    const parts = allocateMoney(money('100.00', 'USD', registry), [1, 1, 1]);

    expect(parts.map(formatMoney)).toEqual(['33.34 USD', '33.33 USD', '33.33 USD']);
    expect(formatMoney(sumMoney(parts, 'USD', registry))).toBe('100.00 USD');
  });

  it('round-trips through JSON as a string', () => {
    // A JSON number would go through a double on the way in.
    const original = money('1234.56', 'USD', registry);
    const json = moneyToJson(original);

    expect(json).toEqual({ currency: 'USD', amount: '1234.56' });
    expect(formatMoney(moneyFromJson(json, registry))).toBe('1234.56 USD');
  });

  it('parses its own canonical form', () => {
    expect(formatMoney(parseMoney('12.34 USD'))).toBe('12.34 USD');
    expect(detailsOf(() => parseMoney('12.34'))).toMatch(/not money/);
    expect(detailsOf(() => parseMoney('$12.34'))).toMatch(/not money/);
  });

  it('displays a negative amount with the sign before the symbol', () => {
    expect(displayMoney(money('-12.34', 'USD', registry), registry)).toBe('-$12.34');
    expect(displayMoney(zeroMoney('USD', registry), registry)).toBe('$0.00');
  });
});

describe('identifiers', () => {
  it('prefixes an id with what it is', () => {
    expect(newFinancialId('transaction')).toMatch(/^txn_[0-9a-f]{32}$/);
    expect(newFinancialId('wallet')).toMatch(/^wlt_/);
  });

  it('catches a transposed id and says which kind it was', () => {
    // Otherwise this is a not-found several layers down, naming the wrong thing.
    const wallet = newFinancialId('wallet');

    expect(isFinancialId(wallet, 'transaction')).toBe(false);
    expect(detailsOf(() => assertFinancialId(wallet, 'transaction'))).toMatch(/It is a wallet id/);
  });

  it('generates references people can read aloud', () => {
    // No 0/O, 1/I/L, 5/S, 8/B, 2/Z — the pairs that become support tickets.
    for (let index = 0; index < 200; index += 1) {
      const reference = newReference('INV');

      expect(reference).toMatch(/^INV-[34679ACDEFGHJKMNPQRTUVWXY]{12}$/);
      expect(referenceSchema.safeParse(reference).success).toBe(true);
    }
  });

  it('rejects a reference that would not survive being typed', () => {
    for (const bad of ['abc123', 'AB', 'A B C D', '-ABCD', 'ABCD-']) {
      expect(referenceSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('idempotency keys', () => {
  const base = {
    organizationId: 'org_a',
    operation: 'payment.create',
    parts: { amount: '10.00', currency: 'USD', payee: 'acc_1' },
  };

  it('is stable across field order', () => {
    const reordered = {
      ...base,
      parts: { payee: 'acc_1', currency: 'USD', amount: '10.00' },
    };

    expect(idempotencyKey(base)).toBe(idempotencyKey(reordered));
  });

  it('differs when anything about the request differs', () => {
    expect(idempotencyKey(base)).not.toBe(
      idempotencyKey({ ...base, parts: { ...base.parts, amount: '10.01' } }),
    );
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, operation: 'payment.refund' }));
  });

  it('is scoped to the tenant', () => {
    /*
     * Without the organization in the hash, one tenant's retry collides with another tenant's
     * first attempt — and returns the other tenant's transaction as a successful idempotent
     * replay.
     */
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, organizationId: 'org_b' }));
    expect(idempotencyKey({ ...base, organizationId: null })).not.toBe(idempotencyKey(base));
  });

  it('ignores an absent optional field rather than hashing "undefined"', () => {
    expect(idempotencyKey(base)).toBe(
      idempotencyKey({ ...base, parts: { ...base.parts, note: undefined } }),
    );
  });
});

describe('statuses', () => {
  it('knows which states nothing follows', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('reversed')).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('authorized')).toBe(false);
  });
});
