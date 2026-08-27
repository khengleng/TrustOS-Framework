import { describe, expect, it } from 'vitest';
import {
  InMemoryQuotaUsageStore,
  assertWithinQuota,
  consumeQuota,
  overageCost,
  periodFor,
  quotaHeaders,
  quotaSchema,
  readQuota,
} from './index';

function quota(overrides: Record<string, unknown> = {}) {
  return quotaSchema.parse({
    quotaId: 'q.partner_a.monthly',
    scope: 'consumer',
    subjectId: 'con_partner_a',
    apiId: 'merchant.api',
    period: 'monthly',
    resetDayOfMonth: 15,
    limit: 100,
    description: 'The monthly call allowance in the partner plan.',
    ...overrides,
  });
}

async function consumeTimes(
  count: number,
  subject = quota(),
  at = new Date('2026-06-20T00:00:00.000Z'),
) {
  const store = new InMemoryQuotaUsageStore();
  let last = await consumeQuota({ quota: subject, store, at });

  for (let index = 1; index < count; index += 1) {
    last = await consumeQuota({ quota: subject, store, at });
  }

  return { last, store };
}

describe('the period', () => {
  it('resets on the day the plan renews', () => {
    /*
     * Not a rolling thirty days. A consumer whose plan renews on the 15th expects the quota to
     * reset on the 15th; a rolling window never resets, it gradually forgets, and nobody can
     * explain that to a customer looking at an invoice.
     */
    const window = periodFor(quota(), new Date('2026-06-20T00:00:00.000Z'));

    expect(window.start.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });

  it('places a date before the reset day in the previous period', () => {
    expect(periodFor(quota(), new Date('2026-06-10T00:00:00.000Z')).key).toBe('2026-05');
  });

  it('handles a daily period', () => {
    expect(periodFor(quota({ period: 'daily' }), new Date('2026-06-20T13:00:00.000Z')).key).toBe(
      '2026-06-20',
    );
  });

  it('handles an annual period', () => {
    expect(periodFor(quota({ period: 'annual' }), new Date('2026-06-20T00:00:00.000Z')).key).toBe(
      '2026',
    );
  });

  it('refuses an anchor day that does not exist in every month', () => {
    // A quota anchored to the 31st resets in seven months and drifts in the other five.
    expect(() => quota({ resetDayOfMonth: 31 })).toThrow();
  });

  it('computes in UTC', () => {
    /*
     * A quota that resets at local midnight resets twice in a year for a consumer whose region
     * observes daylight saving, and one of those resets is an hour short.
     */
    expect(periodFor(quota({ period: 'daily' }), new Date('2026-06-20T23:59:59.000Z')).key).toBe(
      '2026-06-20',
    );
  });
});

describe('consuming', () => {
  it('counts up to the limit', async () => {
    const { last } = await consumeTimes(100);
    expect(last.allowed).toBe(true);
    expect(last.usage.remaining).toBe(0);
  });

  it('refuses the next call under a hard quota', async () => {
    const { last } = await consumeTimes(101);
    expect(last.allowed).toBe(false);
    expect(last.reason).toContain('exhausted');
  });

  it('counts before deciding', async () => {
    // The same reservation problem as the rate limiter: a read-then-write leaves both callers room.
    const store = new InMemoryQuotaUsageStore();
    const at = new Date('2026-06-20T00:00:00.000Z');

    const decisions = await Promise.all(
      Array.from({ length: 105 }, () => consumeQuota({ quota: quota(), store, at })),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(100);
  });

  it('resets in the next period', async () => {
    const { store } = await consumeTimes(100);
    const next = await consumeQuota({
      quota: quota(),
      store,
      at: new Date('2026-07-20T00:00:00.000Z'),
    });

    expect(next.usage.used).toBe(1);
  });

  it('reports the thresholds a call crossed', async () => {
    // Crossed, not exceeded: the notification fires once, on the call that passes the mark.
    const { last } = await consumeTimes(80);
    expect(last.crossedThresholds).toEqual([0.8]);

    const { last: after } = await consumeTimes(81);
    expect(after.crossedThresholds).toEqual([]);
  });

  it('reads usage without consuming it', async () => {
    const { store } = await consumeTimes(40);
    const usage = await readQuota({
      quota: quota(),
      store,
      at: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(usage.used).toBe(40);
    expect(
      (await readQuota({ quota: quota(), store, at: new Date('2026-06-20T00:00:00.000Z') })).used,
    ).toBe(40);
  });
});

describe('overage', () => {
  it('permits and records under a soft quota', async () => {
    /*
     * Reporting this as a plain success would leave nothing to escalate. The call went through and
     * the consumer is past what they bought; both facts belong in the answer.
     */
    const { last } = await consumeTimes(105, quota({ overage: 'soft' }));

    expect(last.allowed).toBe(true);
    expect(last.inOverage).toBe(true);
    expect(last.usage.overageCalls).toBe(5);
  });

  it('prices a billable overage in minor units', async () => {
    const billable = quota({ overage: 'billable', overageUnitPrice: '3', overageCurrency: 'USD' });
    const { last } = await consumeTimes(110, billable);

    expect(last.usage.overageCost).toBe('30');
    expect(last.usage.currency).toBe('USD');
  });

  it('does the arithmetic without floating', async () => {
    /*
     * A month of overage at a sub-cent unit price is exactly where a float loses a digit, and the
     * number is on somebody's invoice. BigInt throughout, minor-unit strings in and out.
     */
    const cost = overageCost(
      quota({
        limit: 1_000_000,
        overage: 'billable',
        overageUnitPrice: '7',
        overageCurrency: 'USD',
      }),
      1_999_999,
    );

    expect(cost?.amount).toBe('6999993');
  });

  it('requires a billable overage to state its price', () => {
    expect(() => quota({ overage: 'billable' })).toThrow(/nobody can invoice it/);
  });

  it('refuses a price on a quota that does not bill', () => {
    // A price nothing charges is a number somebody will eventually invoice from.
    expect(() => quota({ overageUnitPrice: '3', overageCurrency: 'USD' })).toThrow(
      /nothing charges/,
    );
  });

  it('prices nothing when the quota is not exceeded', () => {
    const billable = quota({ overage: 'billable', overageUnitPrice: '3', overageCurrency: 'USD' });
    expect(overageCost(billable, 50)?.amount).toBe('0');
  });
});

describe('what the caller is told', () => {
  it('names quota headers distinctly from rate-limit headers', async () => {
    /*
     * A client that cannot tell which boundary it hit cannot respond to either: slowing down does
     * not help an exhausted quota, and buying more quota does not help a breached rate limit.
     */
    const { last } = await consumeTimes(30);
    const headers = quotaHeaders(last.usage);

    expect(headers['Quota-Remaining']).toBe('70');
    expect(headers['Quota-Reset']).toBe('2026-07-15T00:00:00.000Z');
    expect(headers['RateLimit-Remaining']).toBeUndefined();
  });

  it('throws as rate_limited with a quota reason', async () => {
    const { last } = await consumeTimes(101);

    try {
      assertWithinQuota(last);
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { context?: Record<string, unknown> }).context?.reason).toBe(
        'quota_exhausted',
      );
    }
  });
});
