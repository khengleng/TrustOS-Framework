import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@trustos/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { LimitEngine, limitSchema, windowFor } from './limits';
import { InMemoryLimitStore } from './testing';

/**
 * The window tests are the ones that catch real bugs.
 *
 * "Daily" measured in UTC refuses a customer in Phnom Penh at 07:00 local for spending that, to
 * them, happened yesterday. It is correct in every test written in UTC and wrong for every
 * customer.
 */

const currencies = new CurrencyRegistry();
const usd = (amount: string) => money(amount, 'USD', currencies);

let clock = new Date('2026-03-01T09:00:00.000Z');

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

const limit = (overrides: Record<string, unknown> = {}) =>
  limitSchema.parse({
    id: 'lmt_1',
    organizationId: 'org_a',
    key: 'wallet.daily.usd',
    name: 'daily wallet',
    scope: 'wallet',
    window: 'day',
    timezone: 'UTC',
    currency: 'USD',
    maxAmount: '1000.00',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

function setup(limits: ReturnType<typeof limit>[] = [limit()]) {
  const store = new InMemoryLimitStore(currencies);
  for (const entry of limits) store.add(entry);

  return {
    store,
    engine: new LimitEngine({ store, currencies, now: () => clock }),
  };
}

const subject = {
  organizationId: 'org_a' as string | null,
  scope: 'wallet' as const,
  subjectId: 'wlt_1',
};

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
});

describe('the schema', () => {
  it('refuses a limit that limits nothing', () => {
    const result = limitSchema.safeParse({
      id: 'lmt_1',
      organizationId: 'org_a',
      key: 'k',
      name: 'n',
      scope: 'wallet',
      window: 'day',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/limits nothing/);
  });

  it('refuses an amount limit with no currency', () => {
    /*
     * It would have to convert to compare, and then the limit moves with the exchange rate — a
     * customer under their limit yesterday is over it today because the rate moved.
     */
    const result = limitSchema.safeParse({
      id: 'lmt_1',
      organizationId: 'org_a',
      key: 'k',
      name: 'n',
      scope: 'wallet',
      window: 'day',
      maxAmount: '1000.00',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/move with the exchange rate/);
  });

  it('refuses a rolling window with no span', () => {
    const result = limitSchema.safeParse({
      id: 'lmt_1',
      organizationId: 'org_a',
      key: 'k',
      name: 'n',
      scope: 'wallet',
      window: 'rolling',
      maxCount: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
  });
});

describe('checking', () => {
  it('allows a movement inside the limit', async () => {
    const { engine } = setup();
    const decision = await engine.check({ ...subject, amount: usd('100.00') });

    expect(decision.allowed).toBe(true);
    expect(decision.violations).toEqual([]);
  });

  it('refuses one past the limit and says how much is left', async () => {
    const { engine } = setup();
    const decision = await engine.check({ ...subject, amount: usd('1500.00') });

    expect(decision.allowed).toBe(false);
    expect(decision.violations[0]!.message).toMatch(
      /1500.00 USD would take the daily wallet to 1500.00 USD, past its 1000.00 USD ceiling/,
    );
    expect(decision.violations[0]!.remaining).toBe('1000.00 USD');
  });

  it('accumulates across the window', async () => {
    const { engine } = setup();

    await engine.consume({ ...subject, amount: usd('600.00'), idempotencyKey: 'a' });

    const decision = await engine.check({ ...subject, amount: usd('500.00') });

    expect(decision.allowed).toBe(false);
    expect(decision.violations[0]!.remaining).toBe('400.00 USD');
  });

  it('counts transactions as well as value', async () => {
    const { engine } = setup([
      limit({
        id: 'lmt_2',
        key: 'wallet.count',
        name: 'daily count',
        maxAmount: null,
        maxCount: 3,
        currency: null,
      }),
    ]);

    for (const index of [1, 2, 3]) {
      await engine.consume({ ...subject, idempotencyKey: `k${index}` });
    }

    const decision = await engine.check({ ...subject });

    expect(decision.allowed).toBe(false);
    expect(decision.violations[0]!.message).toMatch(
      /transaction 4 against the daily count ceiling of 3/,
    );
  });

  it('ignores a limit in a different currency', async () => {
    // A 1,000 USD limit says nothing about KHR.
    const { engine } = setup();
    const khr = money('4000000', 'KHR', currencies);

    expect((await engine.check({ ...subject, amount: khr })).allowed).toBe(true);
  });

  it('reports what remains, for a "you have X left today" message', async () => {
    const { engine } = setup();

    await engine.consume({ ...subject, amount: usd('250.00'), idempotencyKey: 'a' });

    const decision = await engine.check({ ...subject, amount: usd('1.00') });

    expect(formatMoney(decision.remaining[0]!.amount!)).toBe('750.00 USD');
  });

  it('keeps one tenant’s limits away from another', async () => {
    const { engine } = setup();

    const decision = await engine.check({
      ...subject,
      organizationId: 'org_b',
      amount: usd('99999.00'),
    });

    expect(decision.allowed).toBe(true);
  });

  it('ignores a disabled limit', async () => {
    const { engine } = setup([limit({ enabled: false })]);

    expect((await engine.check({ ...subject, amount: usd('99999.00') })).allowed).toBe(true);
  });
});

describe('warn-only limits', () => {
  it('does not block, and reports the warning separately', async () => {
    // A warn-only limit is a metric with a threshold, not a rule.
    const { engine } = setup([limit({ enforcement: 'warn', maxAmount: '100.00' })]);

    const decision = await engine.check({ ...subject, amount: usd('500.00') });

    expect(decision.allowed).toBe(true);
    expect(decision.warnings).toHaveLength(1);
    expect(decision.violations).toEqual([]);
  });

  it('lets consume proceed past a warning', async () => {
    const { engine } = setup([limit({ enforcement: 'warn', maxAmount: '100.00' })]);

    await expect(
      engine.consume({ ...subject, amount: usd('500.00'), idempotencyKey: 'a' }),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe('consuming', () => {
  it('throws rather than returning a boolean somebody can ignore', async () => {
    const { engine } = setup();

    const error = await caught(() =>
      engine.consume({ ...subject, amount: usd('1500.00'), idempotencyKey: 'a' }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(detailsOf(error)).toMatch(/past its 1000.00 USD ceiling/);
  });

  it('does not consume twice for a retried transaction', async () => {
    // Otherwise a retry costs the customer their daily limit twice over.
    const { engine } = setup();

    await engine.consume({ ...subject, amount: usd('600.00'), idempotencyKey: 'txn_1' });
    await engine.consume({ ...subject, amount: usd('600.00'), idempotencyKey: 'txn_1' });

    expect((await engine.check({ ...subject, amount: usd('400.00') })).allowed).toBe(true);
  });

  it('gives consumption back when a transaction fails', async () => {
    /*
     * Without this, a failed transaction still counts against the customer's daily limit — and the
     * customer, who was refused, is refused again for a reason nobody can see.
     */
    const { engine } = setup();

    await engine.consume({ ...subject, amount: usd('900.00'), idempotencyKey: 'txn_1' });
    expect((await engine.check({ ...subject, amount: usd('200.00') })).allowed).toBe(false);

    await engine.release({ ...subject, amount: usd('900.00'), idempotencyKey: 'txn_1' });
    expect((await engine.check({ ...subject, amount: usd('200.00') })).allowed).toBe(true);
  });

  it('names every limit that would be exceeded, not just the first', async () => {
    const { engine } = setup([
      limit({ id: 'lmt_1', key: 'a', name: 'daily value', maxAmount: '100.00' }),
      limit({
        id: 'lmt_2',
        key: 'b',
        name: 'daily count',
        maxAmount: null,
        maxCount: 0 + 1,
        currency: null,
      }),
    ]);

    await engine.consume({ ...subject, amount: usd('50.00'), idempotencyKey: 'k1' });

    const error = await caught(() =>
      engine.consume({ ...subject, amount: usd('500.00'), idempotencyKey: 'k2' }),
    );

    expect(detailsOf(error)).toMatch(/daily value/);
    expect(detailsOf(error)).toMatch(/daily count/);
    expect((error as { message: string }).message).toMatch(/2 limits would be exceeded/);
  });
});

describe('windows', () => {
  it('resets a daily limit at local midnight, not UTC midnight', async () => {
    /*
     * The bug this catches: a customer in Phnom Penh (UTC+7) at 07:00 local is at 00:00 UTC. A
     * UTC-based daily limit has just reset for them; a Phnom Penh one reset seven hours earlier.
     */
    const phnomPenh = limit({ timezone: 'Asia/Phnom_Penh' });

    // 2026-03-01T18:00Z is 2026-03-02T01:00 in Phnom Penh — a new local day.
    const window = windowFor(phnomPenh, new Date('2026-03-01T18:00:00.000Z'));

    expect(window.start.toISOString()).toBe('2026-03-01T17:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-02T17:00:00.000Z');
  });

  it('resets a UTC daily limit at UTC midnight', () => {
    const window = windowFor(limit(), new Date('2026-03-01T18:00:00.000Z'));

    expect(window.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('spans a calendar month in the limit’s timezone', () => {
    const window = windowFor(limit({ window: 'month' }), new Date('2026-03-15T00:00:00.000Z'));

    expect(window.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls a December month window into the next year', () => {
    const window = windowFor(limit({ window: 'month' }), new Date('2026-12-15T00:00:00.000Z'));

    expect(window.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles a daylight-saving transition without shifting the window an hour', async () => {
    // New York moves to EDT on 2026-03-08. A window an hour out twice a year refuses somebody for
    // no visible reason on exactly two days.
    const newYork = limit({ timezone: 'America/New_York' });

    const before = windowFor(newYork, new Date('2026-03-07T12:00:00.000Z'));
    const after = windowFor(newYork, new Date('2026-03-09T12:00:00.000Z'));

    expect(before.start.toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(after.start.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('looks back over a rolling window rather than resetting', async () => {
    const { engine } = setup([
      limit({ window: 'rolling', rollingMs: 3_600_000, maxAmount: '100.00' }),
    ]);

    await engine.consume({ ...subject, amount: usd('80.00'), idempotencyKey: 'a' });

    expect((await engine.check({ ...subject, amount: usd('50.00') })).allowed).toBe(false);

    // Two hours later the earlier spend has rolled out of the window.
    clock = new Date(clock.getTime() + 2 * 3_600_000);

    expect((await engine.check({ ...subject, amount: usd('50.00') })).allowed).toBe(true);
  });

  it('does not accumulate a per-transaction limit', async () => {
    const { engine } = setup([limit({ window: 'transaction', maxAmount: '100.00' })]);

    await engine.consume({ ...subject, amount: usd('100.00'), idempotencyKey: 'a' });

    // The next transaction starts fresh: the ceiling is per transaction, not per day.
    expect((await engine.check({ ...subject, amount: usd('100.00') })).allowed).toBe(true);
    expect((await engine.check({ ...subject, amount: usd('101.00') })).allowed).toBe(false);
  });

  it('starts a new window when the day turns', async () => {
    const { engine } = setup();

    await engine.consume({ ...subject, amount: usd('900.00'), idempotencyKey: 'a' });
    expect((await engine.check({ ...subject, amount: usd('200.00') })).allowed).toBe(false);

    clock = new Date('2026-03-02T09:00:00.000Z');

    expect((await engine.check({ ...subject, amount: usd('900.00') })).allowed).toBe(true);
  });
});

describe('the race the engine cannot solve alone', () => {
  it('lets two concurrent checks both pass, which is why consume exists', async () => {
    /*
     * Documented rather than fixed here. `check` is a read; two callers reading the same number
     * both see room. The store's `consume` must be atomic and must run in the same database
     * transaction as the posting — stated on the interface, because an implementation that does
     * otherwise passes every single-threaded test.
     */
    const { engine } = setup();

    const [first, second] = await Promise.all([
      engine.check({ ...subject, amount: usd('600.00') }),
      engine.check({ ...subject, amount: usd('600.00') }),
    ]);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });
});
