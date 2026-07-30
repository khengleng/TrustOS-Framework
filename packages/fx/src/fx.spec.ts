import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@trustos/errors';
import {
  CurrencyRegistry,
  formatDecimal,
  formatMoney,
  money,
  parseDecimal,
} from '@trustos/financial-core';
import { FxService, applySpread, describeConversion, impliedRate } from './rates';
import { InMemoryRateStore } from './testing';

/**
 * The tests here are mostly about what a conversion *records*.
 *
 * A converted amount without its rate cannot be checked, reversed or explained — and "why is this
 * 3.99 and not 4.00" is a question asked months later by somebody who was not there.
 */

const currencies = new CurrencyRegistry();
const usd = (amount: string) => money(amount, 'USD', currencies);
const khr = (amount: string) => money(amount, 'KHR', currencies);

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function detailsOf(error: unknown): string {
  const details = (error as { details?: Array<{ message: string }> }).details ?? [];
  return details.map((detail) => detail.message).join(' | ');
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a throw and got none.');
}

function setup(options: { maxRateAgeMs?: number } = {}) {
  const store = new InMemoryRateStore();

  const fx = new FxService({
    store,
    currencies,
    ...options,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { store, fx };
}

const record = (fx: FxService, overrides: Record<string, unknown> = {}) =>
  fx.record({
    organizationId: 'org_a',
    fromCurrency: 'USD',
    toCurrency: 'KHR',
    rate: '4090',
    source: 'treasury',
    ...overrides,
  });

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('recording a rate', () => {
  it('refuses a rate from a currency to itself', async () => {
    // Storing one invites a conversion that applies a spread to an identity.
    await expect(record(setup().fx, { toCurrency: 'USD' })).rejects.toThrow(ApiError);
  });

  it('refuses a zero or negative rate', async () => {
    /*
     * Zero converts every amount to nothing; negative converts it to its opposite. Both post
     * cleanly and balance, which is why they are refused here rather than noticed in a report.
     */
    const { fx } = setup();

    await expect(record(fx, { rate: '0' })).rejects.toThrow(ApiError);
    await expect(record(fx, { rate: '-4090' })).rejects.toThrow(ApiError);
  });

  it('refuses a rate in an unconfigured currency', async () => {
    const { fx } = setup();

    await expect(record(fx, { toCurrency: 'XYZ' })).rejects.toThrow(/Unknown currency/);
  });

  it('keeps the rate as a string, at whatever precision it was quoted', async () => {
    const { fx } = setup();
    const rate = await record(fx, { rate: '4090.12345678' });

    expect(rate.rate).toBe('4090.12345678');
  });
});

describe('conversion', () => {
  it('converts and records everything needed to check it', async () => {
    const { fx } = setup();
    await record(fx);

    const conversion = await fx.convert({
      organizationId: 'org_a',
      amount: usd('100.00'),
      toCurrency: 'KHR',
    });

    expect(formatMoney(conversion.to)).toBe('409000 KHR');
    expect(conversion.baseRate).toBe('4090');
    expect(conversion.source).toBe('treasury');
    expect(conversion.quotedAt).toEqual(clock);
    expect(conversion.rateId).toMatch(/^rte_/);
  });

  it('rounds to the target currency’s precision', async () => {
    // KHR has no minor unit, so the result is a whole number of riel.
    const { fx } = setup();
    await record(fx, { rate: '4090.5' });

    const conversion = await fx.convert({
      organizationId: 'org_a',
      amount: usd('0.01'),
      toCurrency: 'KHR',
    });

    expect(formatMoney(conversion.to)).toBe('41 KHR');
  });

  it('refuses to convert a currency to itself', async () => {
    // Always a bug at the call site, and the version that succeeds charges a spread on an identity.
    const { fx } = setup();

    const error = await caught(() =>
      fx.convert({ organizationId: 'org_a', amount: usd('1.00'), toCurrency: 'USD' }),
    );

    expect(detailsOf(error)).toMatch(/charges a spread on an identity/);
  });

  it('says the framework ships no rate source when none is configured', async () => {
    const { fx } = setup();

    const error = await caught(() =>
      fx.convert({ organizationId: 'org_a', amount: usd('1.00'), toCurrency: 'KHR' }),
    );

    expect(detailsOf(error)).toMatch(/commercial decision, not a technical one/);
  });

  it('does not use one tenant’s rate for another', async () => {
    const { fx } = setup();
    await record(fx, { organizationId: 'org_a' });

    await expect(
      fx.convert({ organizationId: 'org_b', amount: usd('1.00'), toCurrency: 'KHR' }),
    ).rejects.toThrow(/No exchange rate/);
  });

  it('selects by source when one is named', async () => {
    const { fx } = setup();
    await record(fx, { source: 'treasury', rate: '4090' });
    await record(fx, { source: 'provider-x', rate: '4050' });

    const conversion = await fx.convert({
      organizationId: 'org_a',
      amount: usd('100.00'),
      toCurrency: 'KHR',
      source: 'provider-x',
    });

    expect(formatMoney(conversion.to)).toBe('405000 KHR');
  });
});

describe('staleness', () => {
  it('refuses a rate older than the tolerance', async () => {
    /*
     * A rate feed that has stopped is the common failure. Converting at last week's number is the
     * symptom nobody sees until reconciliation.
     */
    const { fx } = setup({ maxRateAgeMs: 60_000 });
    await record(fx);

    clock = new Date(clock.getTime() + 120_000);

    const error = await caught(() =>
      fx.convert({ organizationId: 'org_a', amount: usd('1.00'), toCurrency: 'KHR' }),
    );

    expect(detailsOf(error)).toMatch(/quoted 120s ago and the limit is 60s/);
  });

  it('lets a deployment that fixes rates daily say so', async () => {
    const { fx } = setup({ maxRateAgeMs: 60_000 });
    await record(fx);

    clock = new Date(clock.getTime() + 12 * 3_600_000);

    await expect(
      fx.convert({
        organizationId: 'org_a',
        amount: usd('1.00'),
        toCurrency: 'KHR',
        maxRateAgeMs: 24 * 3_600_000,
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses an explicitly expired rate whatever the tolerance', async () => {
    const { fx } = setup({ maxRateAgeMs: 24 * 3_600_000 });

    await record(fx, { expiresAt: new Date(clock.getTime() + 60_000) });

    clock = new Date(clock.getTime() + 120_000);

    const error = await caught(() =>
      fx.convert({ organizationId: 'org_a', amount: usd('1.00'), toCurrency: 'KHR' }),
    );

    expect(detailsOf(error)).toMatch(/expired at/);
  });
});

describe('spread', () => {
  it('always costs the customer, and reports what it cost', async () => {
    // A spread that sometimes favoured the customer would not be a spread.
    const { fx } = setup();
    await record(fx);

    const conversion = await fx.convert({
      organizationId: 'org_a',
      amount: usd('100.00'),
      toCurrency: 'KHR',
      spread: { basisPoints: 50, revenueAccountCode: 'fee.fx.khr' },
    });

    // 0.5% off 409,000.
    expect(formatMoney(conversion.to)).toBe('406955 KHR');
    expect(formatMoney(conversion.spreadAmount)).toBe('2045 KHR');
    expect(conversion.spreadBasisPoints).toBe(50);
  });

  it('keeps the base rate visible beside the effective one', async () => {
    /*
     * A rate with the margin baked in cannot be reconciled against the source it came from, and
     * the margin is revenue that belongs in its own account.
     */
    const { fx } = setup();
    await record(fx);

    const conversion = await fx.convert({
      organizationId: 'org_a',
      amount: usd('100.00'),
      toCurrency: 'KHR',
      spread: { basisPoints: 100 },
    });

    expect(conversion.baseRate).toBe('4090');
    expect(conversion.effectiveRate).toBe('4049.10000000');
  });

  it('is a no-op at zero basis points', () => {
    const rate = parseDecimal('4090');
    expect(formatDecimal(applySpread(rate, 0))).toBe('4090');
  });

  it('reduces the rate proportionally', () => {
    expect(formatDecimal(applySpread(parseDecimal('100'), 1_000))).toBe('90.00000000');
  });
});

describe('historical lookup', () => {
  it('uses the rate that applied on the date, not today’s', async () => {
    // Otherwise every restated report changes.
    const { fx } = setup({ maxRateAgeMs: 365 * 24 * 3_600_000 });

    await record(fx, { rate: '4000', quotedAt: new Date('2026-01-10T00:00:00.000Z') });
    await record(fx, { rate: '4090', quotedAt: new Date('2026-02-10T00:00:00.000Z') });

    const january = await fx.convert({
      organizationId: 'org_a',
      amount: usd('100.00'),
      toCurrency: 'KHR',
      asOf: new Date('2026-01-20T00:00:00.000Z'),
    });

    expect(formatMoney(january.to)).toBe('400000 KHR');
  });

  it('returns the rate history for an audit', async () => {
    const { fx } = setup();

    await record(fx, { rate: '4000', quotedAt: new Date('2026-01-10T00:00:00.000Z') });
    await record(fx, { rate: '4090', quotedAt: new Date('2026-02-10T00:00:00.000Z') });

    const history = await fx.history({
      organizationId: 'org_a',
      fromCurrency: 'USD',
      toCurrency: 'KHR',
    });

    expect(history.map((rate) => rate.rate)).toEqual(['4090', '4000']);
  });
});

describe('implied rate', () => {
  it('derives the rate a counterparty used from the two legs', async () => {
    // For reconciliation: the counterparty reports the amounts and not the rate.
    expect(formatDecimal(impliedRate(usd('100.00'), khr('409000')))).toBe('4090.00000000');
  });

  it('refuses to imply a rate from nothing', () => {
    expect(() => impliedRate(usd('0.00'), khr('409000'))).toThrow(ApiError);
  });
});

describe('describing a conversion', () => {
  it('reads as a sentence, with the spread when there is one', async () => {
    const { fx } = setup();
    await record(fx);

    const conversion = await fx.convert({
      organizationId: 'org_a',
      amount: usd('100.00'),
      toCurrency: 'KHR',
      spread: { basisPoints: 50 },
    });

    const description = describeConversion(conversion);

    expect(description).toMatch(/100.00 USD → 406955 KHR at 4069.55000000/);
    expect(description).toMatch(/spread 50bp costing 2045 KHR/);
  });
});
