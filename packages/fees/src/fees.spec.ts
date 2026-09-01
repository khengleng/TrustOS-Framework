import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustsystem/financial-core';
import {
  FeeService,
  calculateFee,
  calculationFromJson,
  calculationToJson,
  feeScheduleSchema,
  validateSchedule,
} from './schedule';
import { InMemoryFeeScheduleStore } from './testing';

/**
 * Two kinds of test here.
 *
 * The arithmetic ones check numbers against what a counterparty would compute. The versioning ones
 * check that last month's invoice still prices to last month's number — which is the property that
 * makes a fee schedule a contract rather than a setting.
 */

const currencies = new CurrencyRegistry();
const usd = (amount: string) => money(amount, 'USD', currencies);

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

const schedule = (overrides: Record<string, unknown> = {}) =>
  feeScheduleSchema.parse({
    id: 'fee_1',
    organizationId: 'org_a',
    key: 'payment.standard',
    version: 1,
    name: 'Standard payment fee',
    currency: 'USD',
    components: [
      {
        name: 'Processing',
        kind: 'percentage',
        basisPoints: 250,
        revenueAccountCode: 'fee.processing.usd',
      },
    ],
    status: 'published',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

function setup() {
  const store = new InMemoryFeeScheduleStore();

  const fees = new FeeService({
    store,
    currencies,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { store, fees };
}

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('the arithmetic', () => {
  it('computes a percentage exactly', () => {
    // 2.5% of 1234.56 is exactly 30.864, which rounds to 30.86.
    const result = calculateFee({ schedule: schedule(), amount: usd('1234.56'), currencies });

    expect(formatMoney(result.total)).toBe('30.86 USD');
  });

  it('adds a flat component to a percentage', () => {
    const result = calculateFee({
      schedule: schedule({
        components: [
          { name: 'Processing', kind: 'percentage', basisPoints: 250 },
          { name: 'Network', kind: 'flat', amount: '0.30' },
        ],
      }),
      amount: usd('100.00'),
      currencies,
    });

    expect(formatMoney(result.total)).toBe('2.80 USD');
    expect(result.lines.map((line) => formatMoney(line.amount))).toEqual(['2.50 USD', '0.30 USD']);
  });

  it('prices a tiered fee from the right tier', () => {
    const tiered = schedule({
      components: [
        {
          name: 'Processing',
          kind: 'tiered',
          tiers: [
            { fromAmount: '0.00', toAmount: '100.00', basisPoints: 300 },
            { fromAmount: '100.00', toAmount: '1000.00', basisPoints: 200 },
            { fromAmount: '1000.00', toAmount: null, basisPoints: 100, flatAmount: '1.00' },
          ],
        },
      ],
    });

    expect(
      formatMoney(calculateFee({ schedule: tiered, amount: usd('50.00'), currencies }).total),
    ).toBe('1.50 USD');
    expect(
      formatMoney(calculateFee({ schedule: tiered, amount: usd('500.00'), currencies }).total),
    ).toBe('10.00 USD');
    // The top tier: 1% of 2000 plus the flat 1.00.
    expect(
      formatMoney(calculateFee({ schedule: tiered, amount: usd('2000.00'), currencies }).total),
    ).toBe('21.00 USD');
  });

  it('treats a tier boundary as inclusive below and exclusive above', () => {
    // Exactly 100.00 belongs to the second tier, not the first. Off by one here is a fee that is
    // wrong for exactly the round numbers customers use.
    const tiered = schedule({
      components: [
        {
          name: 'Processing',
          kind: 'tiered',
          tiers: [
            { fromAmount: '0.00', toAmount: '100.00', basisPoints: 300 },
            { fromAmount: '100.00', toAmount: null, basisPoints: 100 },
          ],
        },
      ],
    });

    expect(
      formatMoney(calculateFee({ schedule: tiered, amount: usd('99.99'), currencies }).total),
    ).toBe('3.00 USD');
    expect(
      formatMoney(calculateFee({ schedule: tiered, amount: usd('100.00'), currencies }).total),
    ).toBe('1.00 USD');
  });

  it('refuses an amount that falls in no tier', () => {
    // A gap charges nothing for the transactions that land in it, and nobody notices until the
    // revenue report.
    const gapped = schedule({
      components: [
        {
          name: 'Processing',
          kind: 'tiered',
          tiers: [{ fromAmount: '0.00', toAmount: '100.00', basisPoints: 300 }],
        },
      ],
    });

    try {
      calculateFee({ schedule: gapped, amount: usd('500.00'), currencies });
      expect.unreachable();
    } catch (error) {
      expect(detailsOf(error)).toMatch(/falls into no tier/);
    }
  });
});

describe('order of application', () => {
  it('applies discount, then cap, then tax', () => {
    /*
     * A capped fee is capped before tax, not after. Getting this backwards means a customer at
     * the cap pays a different total than the cap says.
     */
    const result = calculateFee({
      schedule: schedule({
        components: [
          { name: 'Processing', kind: 'percentage', basisPoints: 1000 },
          { name: 'Loyalty', kind: 'discount', basisPoints: 1000 },
          { name: 'VAT', kind: 'tax', basisPoints: 1000 },
        ],
        maximumFee: '5.00',
      }),
      amount: usd('100.00'),
      currencies,
    });

    // 10.00 fee, 10% discount → 9.00, capped at 5.00, then 10% VAT → 5.50.
    expect(result.adjustment).toMatch(/Capped at 5.00 USD from 9.00 USD/);
    expect(formatMoney(result.total)).toBe('5.50 USD');
  });

  it('raises to the minimum before tax', () => {
    const result = calculateFee({
      schedule: schedule({
        components: [
          { name: 'Processing', kind: 'percentage', basisPoints: 100 },
          { name: 'VAT', kind: 'tax', basisPoints: 1000 },
        ],
        minimumFee: '1.00',
      }),
      amount: usd('10.00'),
      currencies,
    });

    // 0.10 raised to 1.00, then 10% VAT.
    expect(result.adjustment).toMatch(/Raised to the 1.00 USD minimum/);
    expect(formatMoney(result.total)).toBe('1.10 USD');
  });

  it('never lets a discount turn a fee into a payment', () => {
    const result = calculateFee({
      schedule: schedule({
        components: [
          { name: 'Processing', kind: 'percentage', basisPoints: 100 },
          { name: 'Promotion', kind: 'discount', amount: '50.00' },
        ],
      }),
      amount: usd('100.00'),
      currencies,
    });

    expect(formatMoney(result.total)).toBe('0.00 USD');
  });
});

describe('showing the working', () => {
  it('explains every line', () => {
    // "Why is this 2.80" is a question with an answer, and the answer should not require somebody
    // to re-derive it.
    const result = calculateFee({
      schedule: schedule({
        components: [
          { name: 'Processing', kind: 'percentage', basisPoints: 250 },
          { name: 'Network', kind: 'flat', amount: '0.30' },
        ],
      }),
      amount: usd('100.00'),
      currencies,
    });

    expect(result.lines[0]!.explanation).toBe('2.5% of 100.00 USD');
    expect(result.lines[1]!.explanation).toBe('Flat 0.30 USD');
  });

  it('names the schedule and version that priced it', () => {
    const result = calculateFee({
      schedule: schedule({ version: 4 }),
      amount: usd('100.00'),
      currencies,
    });

    expect(result.scheduleKey).toBe('payment.standard');
    expect(result.scheduleVersion).toBe(4);
  });

  it('says which tier applied', () => {
    const result = calculateFee({
      schedule: schedule({
        components: [
          {
            name: 'Processing',
            kind: 'tiered',
            tiers: [{ fromAmount: '0.00', toAmount: null, basisPoints: 250 }],
          },
        ],
      }),
      amount: usd('100.00'),
      currencies,
    });

    expect(result.lines[0]!.explanation).toMatch(/tier from 0.00 and above/);
  });

  it('round-trips through JSON, for storing beside a transaction', () => {
    const result = calculateFee({ schedule: schedule(), amount: usd('100.00'), currencies });
    const restored = calculationFromJson(calculationToJson(result), currencies);

    expect(formatMoney(restored.total)).toBe(formatMoney(result.total));
    expect(restored.lines[0]!.explanation).toBe(result.lines[0]!.explanation);
  });
});

describe('schedule validation', () => {
  it('catches overlapping tiers', () => {
    // Which tier applies would depend on array order.
    const problems = validateSchedule(
      schedule({
        components: [
          {
            name: 'Processing',
            kind: 'tiered',
            tiers: [
              { fromAmount: '0.00', toAmount: '200.00', basisPoints: 300 },
              { fromAmount: '100.00', toAmount: null, basisPoints: 100 },
            ],
          },
        ],
      }),
      currencies,
    );

    expect(problems[0]).toMatch(/tiers overlap/);
  });

  it('catches a gap', () => {
    const problems = validateSchedule(
      schedule({
        components: [
          {
            name: 'Processing',
            kind: 'tiered',
            tiers: [
              { fromAmount: '0.00', toAmount: '100.00', basisPoints: 300 },
              { fromAmount: '200.00', toAmount: null, basisPoints: 100 },
            ],
          },
        ],
      }),
      currencies,
    );

    expect(problems[0]).toMatch(/gap between 100.00 and 200.00/);
  });

  it('catches a missing top tier', () => {
    const problems = validateSchedule(
      schedule({
        components: [
          {
            name: 'Processing',
            kind: 'tiered',
            tiers: [{ fromAmount: '0.00', toAmount: '100.00', basisPoints: 300 }],
          },
        ],
      }),
      currencies,
    );

    expect(problems[0]).toMatch(/no open-ended top tier/);
  });

  it('catches a minimum above the maximum', () => {
    const problems = validateSchedule(
      schedule({ minimumFee: '10.00', maximumFee: '5.00' }),
      currencies,
    );

    expect(problems[0]).toMatch(/contradict each other/);
  });

  it('is quiet on a correct schedule', () => {
    expect(validateSchedule(schedule(), currencies)).toEqual([]);
  });
});

describe('versioning', () => {
  it('prices an old transaction at the version that was live then', async () => {
    /*
     * The property that makes a fee schedule a contract. Changing what a customer is charged by
     * editing a row means last month's invoice recalculates and their copy no longer matches.
     */
    const { fees } = setup();

    clock = new Date('2026-01-01T00:00:00.000Z');
    const v1 = await fees.draft({
      organizationId: 'org_a',
      key: 'payment.standard',
      name: 'Standard',
      currency: 'USD',
      components: [{ name: 'Processing', kind: 'percentage', basisPoints: 250 }],
    });
    await fees.publish({ id: v1.id, organizationId: 'org_a' });

    clock = new Date('2026-02-01T00:00:00.000Z');
    const v2 = await fees.draft({
      organizationId: 'org_a',
      key: 'payment.standard',
      name: 'Standard',
      currency: 'USD',
      components: [{ name: 'Processing', kind: 'percentage', basisPoints: 300 }],
      effectiveFrom: new Date('2026-02-01T00:00:00.000Z'),
    });
    await fees.publish({ id: v2.id, organizationId: 'org_a' });

    const january = await fees.calculate({
      organizationId: 'org_a',
      key: 'payment.standard',
      amount: usd('100.00'),
      at: new Date('2026-01-15T00:00:00.000Z'),
    });

    const february = await fees.calculate({
      organizationId: 'org_a',
      key: 'payment.standard',
      amount: usd('100.00'),
      at: new Date('2026-02-15T00:00:00.000Z'),
    });

    expect(formatMoney(january.total)).toBe('2.50 USD');
    expect(january.scheduleVersion).toBe(1);
    expect(formatMoney(february.total)).toBe('3.00 USD');
    expect(february.scheduleVersion).toBe(2);
  });

  it('assigns the next version number', async () => {
    const { fees } = setup();

    const first = await fees.draft({
      organizationId: 'org_a',
      key: 'payment.standard',
      name: 'x',
      currency: 'USD',
      components: [{ name: 'Processing', kind: 'percentage', basisPoints: 250 }],
    });

    const second = await fees.draft({
      organizationId: 'org_a',
      key: 'payment.standard',
      name: 'x',
      currency: 'USD',
      components: [{ name: 'Processing', kind: 'percentage', basisPoints: 250 }],
    });

    expect([first.version, second.version]).toEqual([1, 2]);
  });

  it('refuses to publish twice', async () => {
    const { fees } = setup();

    const draft = await fees.draft({
      organizationId: 'org_a',
      key: 'payment.standard',
      name: 'x',
      currency: 'USD',
      components: [{ name: 'Processing', kind: 'percentage', basisPoints: 250 }],
    });

    await fees.publish({ id: draft.id, organizationId: 'org_a' });

    await expect(fees.publish({ id: draft.id, organizationId: 'org_a' })).rejects.toThrow(
      /a change is a new version/,
    );
  });

  it('refuses a draft with bad tiers before it can be published', async () => {
    const { fees } = setup();

    const error = await caught(() =>
      fees.draft({
        organizationId: 'org_a',
        key: 'payment.standard',
        name: 'x',
        currency: 'USD',
        components: [
          {
            name: 'Processing',
            kind: 'tiered',
            tiers: [{ fromAmount: '0.00', toAmount: '100.00', basisPoints: 300 }],
          },
        ],
      }),
    );

    expect(detailsOf(error)).toMatch(/no open-ended top tier/);
  });

  it('says when no version was effective at a moment', async () => {
    const { fees } = setup();

    const error = await caught(() =>
      fees.calculate({
        organizationId: 'org_a',
        key: 'payment.standard',
        amount: usd('100.00'),
      }),
    );

    expect(detailsOf(error)).toMatch(/No published version of the "payment.standard" fee schedule/);
  });

  it('does not price with another tenant’s schedule', async () => {
    const { fees } = setup();

    const draft = await fees.draft({
      organizationId: 'org_a',
      key: 'payment.standard',
      name: 'x',
      currency: 'USD',
      components: [{ name: 'Processing', kind: 'percentage', basisPoints: 250 }],
    });
    await fees.publish({ id: draft.id, organizationId: 'org_a' });

    await expect(
      fees.calculate({ organizationId: 'org_b', key: 'payment.standard', amount: usd('100.00') }),
    ).rejects.toThrow(ApiError);
  });
});

describe('currency', () => {
  it('refuses an amount in a currency the schedule does not price', () => {
    const khr = money('400000', 'KHR', currencies);

    try {
      calculateFee({ schedule: schedule(), amount: khr, currencies });
      expect.unreachable();
    } catch (error) {
      expect(detailsOf(error)).toMatch(/prices in USD and this amount is in KHR/);
      expect(detailsOf(error)).toMatch(/@trustsystem\/fx/);
    }
  });
});
