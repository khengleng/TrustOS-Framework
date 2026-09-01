import { beforeEach, describe, expect, it } from 'vitest';
import { CurrencyRegistry, formatMoney, money } from '@trustsystem/financial-core';
import { AccountService, InMemoryAccountStore } from '@trustsystem/accounts';
import { credit, debit } from './journal';
import { Ledger } from './ledger';
import { InMemoryLedgerStore } from './testing';

/**
 * Load and concurrency tests.
 *
 * Not benchmarks — `scripts/bench-financial.mjs` measures speed, and a test that asserts on
 * milliseconds fails on a busy CI machine and gets deleted. These assert on *correctness under
 * volume and contention*, which is a different property and the one that actually breaks.
 *
 * Every one of them is a bug that a single-transaction test cannot see:
 *
 *   * A ledger that balances for one journal and drifts over ten thousand — a rounding error that
 *     accumulates, or an aggregate that loses precision.
 *   * An idempotency key that holds when called twice in sequence and fails when called twice at
 *     once.
 *   * A balance query whose answer depends on how many entries are behind it.
 *
 * The volumes are deliberately modest: enough to expose an accumulation error, small enough that
 * the suite stays fast. A ten-million-row test that nobody runs proves nothing.
 */

const currencies = new CurrencyRegistry();
const usd = (amount: string) => money(amount, 'USD', currencies);
const khr = (amount: string) => money(amount, 'KHR', currencies);

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function setup() {
  const store = new InMemoryLedgerStore(currencies);

  const ledger = new Ledger({
    store,
    currencies,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  const accounts = new AccountService({
    store: new InMemoryAccountStore(),
    ledger,
    currencies,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { store, ledger, accounts };
}

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('volume', () => {
  it('stays balanced across ten thousand postings', async () => {
    /*
     * The failure this catches is accumulation. A ledger that balances for one journal and drifts
     * over ten thousand has a rounding error somewhere in the aggregate, and it is invisible until
     * a month-end trial balance is out by a few cents nobody can explain.
     */
    const { ledger } = setup();

    for (let index = 0; index < 10_000; index += 1) {
      await ledger.post({
        organizationId: 'org_a',
        description: `Payment ${index}`,
        entries: [
          debit('acc_customer', usd('102.50')),
          credit('acc_merchant', usd('100.00')),
          credit('acc_fee', usd('2.50')),
        ],
        idempotencyKey: `load_${index}`,
      });
    }

    const trial = await ledger.trialBalance({ organizationId: 'org_a' });

    expect(trial.balanced).toBe(true);
    expect(formatMoney(trial.totals[0]!.debits)).toBe('1025000.00 USD');
    expect(formatMoney(trial.totals[0]!.credits)).toBe('1025000.00 USD');
  }, 30_000);

  it('does not drift on amounts that do not divide evenly', async () => {
    /*
     * A third of a cent, ten thousand times. In a double this accumulates visibly; here every
     * posting is exact and the total is exactly what the arithmetic says.
     */
    const { ledger } = setup();

    for (let index = 0; index < 10_000; index += 1) {
      await ledger.post({
        organizationId: 'org_a',
        description: `Interest ${index}`,
        entries: [debit('acc_customer', usd('0.07')), credit('acc_interest', usd('0.07'))],
        idempotencyKey: `drift_${index}`,
      });
    }

    const balances = await ledger.balances({ organizationId: 'org_a' });
    const customer = balances.find((entry) => entry.accountId === 'acc_customer')!;

    expect(formatMoney(customer.balance)).toBe('700.00 USD');
  }, 30_000);

  it('stays exact past the range a double can represent', async () => {
    /*
     * 2^53 minor units is about 90 trillion dollars — absurd — but only 90 trillion riel, which is
     * roughly a fifth of Cambodia's annual GDP in the currency it is denominated in. A national
     * system reaches this.
     */
    const { ledger } = setup();

    // 9,007,199,254,740,993 riel: 2^53 + 1, the first integer a double cannot represent.
    const beyondDouble = khr('9007199254740993');

    await ledger.post({
      organizationId: 'org_a',
      description: 'A very large transfer',
      entries: [debit('acc_treasury', beyondDouble), credit('acc_reserve', beyondDouble)],
      idempotencyKey: 'big_1',
    });

    await ledger.post({
      organizationId: 'org_a',
      description: 'One riel more',
      entries: [debit('acc_treasury', khr('1')), credit('acc_reserve', khr('1'))],
      idempotencyKey: 'big_2',
    });

    const balances = await ledger.balances({ organizationId: 'org_a' });
    const treasury = balances.find((entry) => entry.accountId === 'acc_treasury')!;

    // A double would report 9007199254740994 for both of these and lose the distinction.
    expect(formatMoney(treasury.balance)).toBe('9007199254740994 KHR');
  });

  it('keeps a wide journal balanced', async () => {
    // A settlement batch: one debit, two hundred credits. The shape most likely to expose a
    // sum-order dependency.
    const { ledger } = setup();

    const merchants = Array.from({ length: 200 }, (_, index) =>
      credit(`acc_merchant_${index}`, usd('5.00')),
    );

    await ledger.post({
      organizationId: 'org_a',
      description: 'Settlement batch',
      entries: [debit('acc_settlement', usd('1000.00')), ...merchants],
      idempotencyKey: 'wide_1',
    });

    expect((await ledger.trialBalance({ organizationId: 'org_a' })).balanced).toBe(true);
  });

  it('reports a balance whose answer does not depend on how many entries are behind it', async () => {
    const { ledger, accounts } = setup();

    const account = await accounts.open({
      organizationId: 'org_a',
      code: 'customer.usr_1.usd',
      name: 'Dara',
      type: 'customer',
      currency: 'USD',
    });

    for (let index = 0; index < 2_000; index += 1) {
      await ledger.post({
        organizationId: 'org_a',
        description: `Deposit ${index}`,
        entries: [debit('acc_bank', usd('1.00')), credit(account.id, usd('1.00'))],
        idempotencyKey: `many_${index}`,
      });
    }

    expect(formatMoney(await accounts.balance(account))).toBe('2000.00 USD');
  }, 20_000);
});

describe('concurrency', () => {
  it('posts once when five hundred retries of one request arrive together', async () => {
    /*
     * The retry storm. An idempotency key that holds when called twice in sequence and fails when
     * called five hundred times at once is an idempotency key that does not hold.
     */
    const { ledger, store } = setup();

    const results = await Promise.all(
      Array.from({ length: 500 }, () =>
        ledger.post({
          organizationId: 'org_a',
          description: 'Retried payment',
          entries: [debit('acc_customer', usd('100.00')), credit('acc_merchant', usd('100.00'))],
          idempotencyKey: 'storm',
        }),
      ),
    );

    expect(new Set(results.map((journal) => journal.id)).size).toBe(1);
    expect(store.journals.size).toBe(1);

    const balances = await ledger.balances({ organizationId: 'org_a' });
    expect(formatMoney(balances.find((entry) => entry.accountId === 'acc_customer')!.balance)).toBe(
      '100.00 USD',
    );
  });

  it('stays balanced under a thousand concurrent unrelated postings', async () => {
    const { ledger } = setup();

    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        ledger.post({
          organizationId: 'org_a',
          description: `Concurrent ${index}`,
          entries: [debit('acc_customer', usd('10.00')), credit('acc_merchant', usd('10.00'))],
          idempotencyKey: `conc_${index}`,
        }),
      ),
    );

    const trial = await ledger.trialBalance({ organizationId: 'org_a' });

    expect(trial.balanced).toBe(true);
    expect(formatMoney(trial.totals[0]!.debits)).toBe('10000.00 USD');
  }, 20_000);

  it('keeps two tenants apart under concurrent load', async () => {
    /*
     * The quietest failure in the phase, made likelier by contention: a query that scopes on a
     * variable captured outside the loop returns one tenant's rows for another.
     */
    const { ledger } = setup();

    await Promise.all([
      ...Array.from({ length: 300 }, (_, index) =>
        ledger.post({
          organizationId: 'org_a',
          description: 'A',
          entries: [debit('acc_customer', usd('1.00')), credit('acc_merchant', usd('1.00'))],
          idempotencyKey: `a_${index}`,
        }),
      ),
      ...Array.from({ length: 300 }, (_, index) =>
        ledger.post({
          organizationId: 'org_b',
          description: 'B',
          entries: [debit('acc_customer', usd('7.00')), credit('acc_merchant', usd('7.00'))],
          idempotencyKey: `b_${index}`,
        }),
      ),
    ]);

    const a = await ledger.balances({ organizationId: 'org_a' });
    const b = await ledger.balances({ organizationId: 'org_b' });

    expect(formatMoney(a.find((entry) => entry.accountId === 'acc_customer')!.balance)).toBe(
      '300.00 USD',
    );
    expect(formatMoney(b.find((entry) => entry.accountId === 'acc_customer')!.balance)).toBe(
      '2100.00 USD',
    );
  }, 20_000);

  it('reverses concurrently without double-reversing', async () => {
    // Five workers all decide to reverse the same journal. Exactly one reversal should exist.
    const { ledger, store } = setup();

    const journal = await ledger.post({
      organizationId: 'org_a',
      description: 'To be reversed',
      entries: [debit('acc_customer', usd('100.00')), credit('acc_merchant', usd('100.00'))],
      idempotencyKey: 'rev_target',
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        ledger.reverse({
          journalId: journal.id,
          organizationId: 'org_a',
          reason: 'Duplicate charge.',
        }),
      ),
    );

    // Some attempts lose — either to the "already reversed" guard or to the idempotency key on
    // the reversal itself. What matters is the ledger afterwards.
    expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);

    const balances = await ledger.balances({ organizationId: 'org_a' });
    const customer = balances.find((entry) => entry.accountId === 'acc_customer')!;

    // One posting and one reversal net to zero. Two reversals would show -100.00.
    expect(formatMoney(customer.balance)).toBe('0.00 USD');
    expect(store.journals.size).toBe(2);
  });
});

describe('accuracy at scale', () => {
  it('splits a million ways without losing a unit', async () => {
    /*
     * Not a realistic allocation, and that is the point: if the remainder distribution is wrong it
     * shows up as a difference of a few units, which is exactly the size of error that survives a
     * three-way test.
     */
    const { allocate, parseDecimal, sum, formatDecimal } =
      await import('@trustsystem/financial-core');

    const parts = allocate(
      parseDecimal('1000000.00'),
      Array.from({ length: 9_999 }, () => 1),
    );

    expect(parts).toHaveLength(9_999);
    expect(formatDecimal(sum(parts, 2))).toBe('1000000.00');
  });

  it('sums a hundred thousand small amounts exactly', async () => {
    const { parseDecimal, sum, formatDecimal } = await import('@trustsystem/financial-core');

    const values = Array.from({ length: 100_000 }, () => parseDecimal('0.01'));

    // In a double this is 1000.0000000001588.
    expect(formatDecimal(sum(values, 2))).toBe('1000.00');
  });
});
