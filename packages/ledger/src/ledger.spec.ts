import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@trustos/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { checkBalance, credit, debit, isBalanced, mirrorEntries } from './journal';
import { Ledger, contentHashOf } from './ledger';
import { InMemoryLedgerStore, InMemoryPeriodStore } from './testing';

/**
 * The tests that matter are the ones about what a ledger refuses.
 *
 * A ledger that accepts an unbalanced journal, or lets a posted one be edited, still works: every
 * happy path passes, every balance is a number, and nothing throws. It just stops being able to
 * tell you when it is wrong, which was the only reason to have one.
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

function setup(options: { allowedCurrencies?: string[] } = {}) {
  const store = new InMemoryLedgerStore(currencies);
  const audit = { record: vi.fn() };

  const ledger = new Ledger({
    store,
    currencies,
    audit,
    ...options,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { store, audit, ledger };
}

/** A cash sale: cash increases, revenue increases. */
const sale = (amount = '100.00') => [
  debit('acc_cash', usd(amount), { description: 'Cash received' }),
  credit('acc_revenue', usd(amount), { description: 'Sale' }),
];

const post = (ledger: Ledger, overrides: Record<string, unknown> = {}) =>
  ledger.post({
    organizationId: 'org_a',
    description: 'Cash sale',
    entries: sale(),
    actorId: 'usr_1',
    ...overrides,
  });

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('balancing', () => {
  it('accepts a journal whose debits equal its credits', async () => {
    const { ledger } = setup();
    const journal = await post(ledger);

    expect(journal.status).toBe('posted');
    expect(journal.entries).toHaveLength(2);
  });

  it('refuses an unbalanced journal and says by how much', async () => {
    // "Journal does not balance" sends somebody to read every line.
    const { ledger } = setup();

    const error = await caught(() =>
      post(ledger, {
        entries: [debit('acc_cash', usd('100.00')), credit('acc_revenue', usd('99.99'))],
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(detailsOf(error)).toMatch(/USD debits are 100.00 USD and credits are 99.99 USD/);
    expect(detailsOf(error)).toMatch(/difference of 0.01 USD/);
  });

  it('balances per currency, not in total', async () => {
    /*
     * A 100 USD debit against a 400,000 KHR credit does not balance, however close they are at
     * today's rate. Netting across currencies hides the rate that was used.
     */
    const { ledger } = setup();

    const error = await caught(() =>
      post(ledger, {
        entries: [debit('acc_cash', usd('100.00')), credit('acc_revenue', khr('400000'))],
      }),
    );

    expect(detailsOf(error)).toMatch(/USD debits are 100.00 USD and credits are 0.00 USD/);
    expect(detailsOf(error)).toMatch(/KHR/);
  });

  it('accepts a genuine multi-currency journal that balances on both sides', async () => {
    // An exchange: USD out, KHR in, through an FX account with its own two entries.
    const { ledger } = setup();

    const journal = await post(ledger, {
      description: 'Currency exchange',
      entries: [
        credit('acc_cash_usd', usd('100.00')),
        debit('acc_fx', usd('100.00')),
        credit('acc_fx', khr('400000')),
        debit('acc_cash_khr', khr('400000')),
      ],
    });

    expect(journal.status).toBe('posted');
  });

  it('refuses a journal with fewer than two entries', async () => {
    const { ledger } = setup();

    await expect(post(ledger, { entries: [debit('acc_cash', usd('1.00'))] })).rejects.toThrow();
  });

  it('refuses a negative entry amount rather than normalising it', async () => {
    /*
     * A negative debit and a credit are the same movement written two ways. A ledger that accepts
     * both has two representations of every posting, so a report grouped by direction is wrong.
     */
    expect(() => debit('acc_cash', usd('-1.00'))).toThrow(ApiError);

    try {
      credit('acc_cash', usd('-1.00'));
    } catch (error) {
      expect(detailsOf(error)).toMatch(/a negative credit is a debit written backwards/);
    }
  });

  it('refuses a line that cancels itself out', async () => {
    // It balances perfectly and moves nothing — usually a transfer where both sides resolved to
    // the same account, and invisible in every balance because it nets to zero.
    const { ledger } = setup();

    const error = await caught(() =>
      post(ledger, {
        entries: [debit('acc_cash', usd('50.00')), credit('acc_cash', usd('50.00'))],
      }),
    );

    expect(detailsOf(error)).toMatch(/debited and credited for the same amount/);
  });

  it('allows an account to appear on both sides for different amounts', async () => {
    // A legitimate netting: 100 in, 30 out of the same account, plus the counterparties.
    const { ledger } = setup();

    await expect(
      post(ledger, {
        entries: [
          debit('acc_cash', usd('100.00')),
          credit('acc_cash', usd('30.00')),
          credit('acc_revenue', usd('100.00')),
          debit('acc_expense', usd('30.00')),
        ],
      }),
    ).resolves.toMatchObject({ status: 'posted' });
  });

  it('reports the sides without throwing, for a caller that wants to check first', () => {
    const summary = checkBalance([debit('a', usd('10.00')), credit('b', usd('4.00'))]);

    expect(formatMoney(summary[0]!.difference)).toBe('6.00 USD');
    expect(isBalanced([debit('a', usd('10.00')), credit('b', usd('10.00'))])).toBe(true);
  });
});

describe('immutability', () => {
  it('exposes no way to change a posted journal', () => {
    const { ledger } = setup();

    // Not a style assertion: the absence of an update method is the guarantee.
    expect((ledger as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((ledger as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it('detects a journal edited behind the service', async () => {
    /*
     * The application's own database credentials can UPDATE a posted journal. The service's
     * immutability is not the last word — the content hash is.
     */
    const { ledger, store } = setup();
    const journal = await post(ledger);

    const tampered = structuredClone(store.journals.get(journal.id)!);
    tampered.entries[0]!.amount.amount = '1000.00';
    tampered.entries[1]!.amount.amount = '1000.00';
    store.journals.set(journal.id, tampered);

    await expect(ledger.get(journal.id, 'org_a')).rejects.toThrow(
      /does not match its content hash/,
    );
  });

  it('does not treat a reversal as tampering', async () => {
    // Marking the original reversed is a legitimate change, so the hash covers the entries and
    // the effective date rather than the status.
    const { ledger } = setup();
    const journal = await post(ledger);

    await ledger.reverse({ journalId: journal.id, organizationId: 'org_a', reason: 'Duplicate.' });

    await expect(ledger.get(journal.id, 'org_a')).resolves.toMatchObject({ status: 'reversed' });
  });

  it('hashes the content, not the status', async () => {
    const { ledger, store } = setup();
    const journal = await post(ledger);
    const stored = store.journals.get(journal.id)!;

    expect(contentHashOf({ ...stored, status: 'reversed' })).toBe(stored.contentHash);
    expect(contentHashOf({ ...stored, description: 'Something else' })).not.toBe(
      stored.contentHash,
    );
  });
});

describe('reversal', () => {
  it('posts the mirror image and leaves the original standing', async () => {
    const { ledger, store } = setup();
    const journal = await post(ledger);

    const { original, reversal } = await ledger.reverse({
      journalId: journal.id,
      organizationId: 'org_a',
      reason: 'Charged in error.',
    });

    expect(original.status).toBe('reversed');
    expect(original.reversedByJournalId).toBe(reversal.id);

    // Both journals still exist. They net to zero, which is what a reversal means.
    expect(store.journals.size).toBe(2);

    expect(reversal.entries.map((entry) => [entry.accountId, entry.direction])).toEqual([
      ['acc_cash', 'credit'],
      ['acc_revenue', 'debit'],
    ]);
  });

  it('leaves the account balance at zero afterwards', async () => {
    const { ledger } = setup();
    const journal = await post(ledger);

    await ledger.reverse({ journalId: journal.id, organizationId: 'org_a', reason: 'Error.' });

    const balances = await ledger.balances({ organizationId: 'org_a' });
    const cash = balances.find((entry) => entry.accountId === 'acc_cash')!;

    expect(formatMoney(cash.balance)).toBe('0.00 USD');
    expect(cash.entryCount).toBe(2);
  });

  it('refuses to reverse the same journal twice', async () => {
    /*
     * The second reversal balances on its own, posts cleanly, and leaves the account off by the
     * original amount in the other direction.
     */
    const { ledger } = setup();
    const journal = await post(ledger);

    await ledger.reverse({ journalId: journal.id, organizationId: 'org_a', reason: 'Error.' });

    await expect(
      ledger.reverse({ journalId: journal.id, organizationId: 'org_a', reason: 'Again.' }),
    ).rejects.toThrow(/was already reversed by jrn_/);
  });

  it('requires a reason', async () => {
    const { ledger } = setup();
    const journal = await post(ledger);

    const error = await caught(() =>
      ledger.reverse({ journalId: journal.id, organizationId: 'org_a', reason: '  ' }),
    );

    expect(detailsOf(error)).toMatch(/the only record of why the money moved back/);
  });

  it('dates the reversal now, not when the original was effective', async () => {
    // A reversal posted in March for a January journal belongs in March, or January's closed
    // period changes after it closed.
    const { ledger } = setup();

    const journal = await post(ledger, { effectiveAt: new Date('2026-01-15T00:00:00.000Z') });

    clock = new Date('2026-03-20T00:00:00.000Z');

    const { reversal } = await ledger.reverse({
      journalId: journal.id,
      organizationId: 'org_a',
      reason: 'Found in the March review.',
    });

    expect(reversal.effectiveAt).toEqual(new Date('2026-03-20T00:00:00.000Z'));
  });

  it('does not reverse another tenant’s journal', async () => {
    const { ledger } = setup();
    const journal = await post(ledger);

    await expect(
      ledger.reverse({ journalId: journal.id, organizationId: 'org_b', reason: 'Nope.' }),
    ).rejects.toThrow(/No journal with id/);
  });

  it('builds a mirror that balances', () => {
    const entries = [
      { ...debit('a', usd('10.00'), { description: 'Cash received' }), id: 'e1' },
      { ...credit('b', usd('10.00')), id: 'e2' },
    ];

    const mirrored = mirrorEntries(entries, (prefix) => `${prefix}_x`);

    expect(isBalanced(mirrored)).toBe(true);
    expect(mirrored[0]!.direction).toBe('credit');
    expect(mirrored[0]!.description).toBe('Reversal: Cash received');
    // A line with no description of its own still says what it is.
    expect(mirrored[1]!.description).toBe('Reversal');
  });
});

describe('adjustment', () => {
  it('posts the difference rather than undoing and redoing', async () => {
    /*
     * A fee under-charged by 0.10 is an adjustment. Reversing and reposting the whole fee makes
     * the statement show a charge, a refund and a charge, which a customer reads as an error.
     */
    const { ledger } = setup();
    const journal = await post(ledger, { entries: sale('100.00') });

    const adjustment = await ledger.adjust({
      journalId: journal.id,
      organizationId: 'org_a',
      reason: 'Fee under-charged.',
      entries: [debit('acc_cash', usd('0.10')), credit('acc_revenue', usd('0.10'))],
    });

    expect(adjustment.description).toMatch(/^Adjustment to jrn_/);
    expect(adjustment.metadata.adjustsJournalId).toBe(journal.id);

    const balances = await ledger.balances({ organizationId: 'org_a' });
    const cash = balances.find((entry) => entry.accountId === 'acc_cash')!;

    expect(formatMoney(cash.balance)).toBe('100.10 USD');
  });

  it('still refuses an unbalanced adjustment', async () => {
    const { ledger } = setup();
    const journal = await post(ledger);

    await expect(
      ledger.adjust({
        journalId: journal.id,
        organizationId: 'org_a',
        reason: 'Wrong.',
        entries: [debit('acc_cash', usd('0.10')), credit('acc_revenue', usd('0.20'))],
      }),
    ).rejects.toThrow(ApiError);
  });
});

describe('idempotency', () => {
  it('returns the original journal when the same key is posted twice', async () => {
    // A retried posting that posts twice doubles a movement of money, and the second is
    // indistinguishable from a legitimate second transaction for the same amount.
    const { ledger, store } = setup();

    const first = await post(ledger, { idempotencyKey: 'idm_abc' });
    const second = await post(ledger, { idempotencyKey: 'idm_abc' });

    expect(second.id).toBe(first.id);
    expect(store.journals.size).toBe(1);
  });

  it('scopes the key to the tenant', async () => {
    /*
     * Without the tenant in the key, one organization's retry collides with another's first
     * attempt — and returns the other tenant's journal as a successful replay.
     */
    const { ledger, store } = setup();

    await post(ledger, { idempotencyKey: 'idm_abc', organizationId: 'org_a' });
    await post(ledger, { idempotencyKey: 'idm_abc', organizationId: 'org_b' });

    expect(store.journals.size).toBe(2);
  });

  it('posts twice without a key, because nothing said the two were the same request', async () => {
    const { ledger, store } = setup();

    await post(ledger);
    await post(ledger);

    expect(store.journals.size).toBe(2);
  });

  it('reverses idempotently, so a retried reversal does not double the correction', async () => {
    const { ledger, store } = setup();
    const journal = await post(ledger);

    await ledger.reverse({ journalId: journal.id, organizationId: 'org_a', reason: 'Error.' });

    // The second attempt hits the "already reversed" guard, and would hit the idempotency key
    // even if it did not.
    await expect(
      ledger.reverse({ journalId: journal.id, organizationId: 'org_a', reason: 'Error.' }),
    ).rejects.toThrow(/already reversed/);

    expect(store.journals.size).toBe(2);
  });
});

describe('balances and the trial balance', () => {
  it('reports debits, credits and the net per account', async () => {
    const { ledger } = setup();

    await post(ledger, { entries: sale('100.00') });
    await post(ledger, { entries: sale('50.00') });

    const balances = await ledger.balances({ organizationId: 'org_a' });
    const cash = balances.find((entry) => entry.accountId === 'acc_cash')!;
    const revenue = balances.find((entry) => entry.accountId === 'acc_revenue')!;

    expect(formatMoney(cash.balance)).toBe('150.00 USD');
    // Negative for revenue: `debits − credits` is raw arithmetic, and the account's normal side
    // is what makes it a positive balance. That interpretation lives in @trustos/accounts.
    expect(formatMoney(revenue.balance)).toBe('-150.00 USD');
  });

  it('balances across the whole ledger', async () => {
    const { ledger } = setup();

    await post(ledger, { entries: sale('100.00') });
    await post(ledger, {
      description: 'Expense',
      entries: [debit('acc_expense', usd('30.00')), credit('acc_cash', usd('30.00'))],
    });

    const trial = await ledger.trialBalance({ organizationId: 'org_a' });

    expect(trial.balanced).toBe(true);
    expect(trial.problems).toEqual([]);
    expect(formatMoney(trial.totals[0]!.debits)).toBe('130.00 USD');
    expect(formatMoney(trial.totals[0]!.credits)).toBe('130.00 USD');
  });

  it('says the data was changed outside the application when the trial balance does not balance', async () => {
    /*
     * Every journal balances at posting, so this state is unreachable through the service. If it
     * happens, the useful message is the one that says so.
     */
    const { ledger, store } = setup();
    const journal = await post(ledger);

    const tampered = structuredClone(store.journals.get(journal.id)!);
    tampered.entries.pop();
    store.journals.set(journal.id, tampered);

    const trial = await ledger.trialBalance({ organizationId: 'org_a' });

    expect(trial.balanced).toBe(false);
    expect(trial.problems[0]).toMatch(/changed outside the application/);
  });

  it('does not include a draft in any balance', async () => {
    const { ledger, store } = setup();
    const journal = await post(ledger);

    store.journals.set(journal.id, { ...store.journals.get(journal.id)!, status: 'draft' });

    expect(await ledger.balances({ organizationId: 'org_a' })).toEqual([]);
  });

  it('respects an as-of date, so a closed period does not move', async () => {
    const { ledger } = setup();

    await post(ledger, { effectiveAt: new Date('2026-01-15T00:00:00.000Z') });
    await post(ledger, { effectiveAt: new Date('2026-02-15T00:00:00.000Z') });

    const january = await ledger.trialBalance({
      organizationId: 'org_a',
      asOf: new Date('2026-01-31T23:59:59.000Z'),
    });

    expect(formatMoney(january.totals[0]!.debits)).toBe('100.00 USD');
  });

  it('keeps one tenant out of another’s balances', async () => {
    const { ledger } = setup();

    await post(ledger, { organizationId: 'org_a' });
    await post(ledger, { organizationId: 'org_b', entries: sale('999.00') });

    const balances = await ledger.balances({ organizationId: 'org_a' });
    const cash = balances.find((entry) => entry.accountId === 'acc_cash')!;

    expect(formatMoney(cash.balance)).toBe('100.00 USD');
  });
});

describe('currency restriction', () => {
  it('refuses a currency this ledger does not accept', async () => {
    // An account in a currency nobody configured produces a balance nobody can report on or
    // settle.
    const { ledger } = setup({ allowedCurrencies: ['USD'] });

    const error = await caught(() =>
      post(ledger, {
        entries: [debit('acc_cash', khr('400000')), credit('acc_revenue', khr('400000'))],
      }),
    );

    expect(detailsOf(error)).toMatch(/does not accept KHR. Accepted: USD/);
  });
});

describe('audit', () => {
  it('records what moved, not just that something did', async () => {
    const { ledger, audit } = setup();
    await post(ledger, { reference: 'INV-1001' });

    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'ledger.journal.posted',
      organizationId: 'org_a',
      actorId: 'usr_1',
      after: expect.objectContaining({
        reference: 'INV-1001',
        entries: [
          { accountId: 'acc_cash', direction: 'debit', amount: '100.00 USD' },
          { accountId: 'acc_revenue', direction: 'credit', amount: '100.00 USD' },
        ],
      }),
    });
  });

  it('records the reversal with its reason', async () => {
    const { ledger, audit } = setup();
    const journal = await post(ledger);

    await ledger.reverse({
      journalId: journal.id,
      organizationId: 'org_a',
      reason: 'Charged in error.',
      actorId: 'usr_2',
    });

    const reversal = audit.record.mock.calls.find(
      (call) => call[0].action === 'ledger.journal.reversed',
    )!;

    expect(reversal[0]).toMatchObject({
      actorId: 'usr_2',
      after: expect.objectContaining({ reason: 'Charged in error.' }),
    });
  });
});

describe('concurrency', () => {
  it('posts once when the same request arrives twice at the same moment', async () => {
    /*
     * The retry race. Two workers post the same journal with the same key; the store's unique
     * constraint decides, and the loser reads the winner's journal rather than failing.
     */
    const { ledger, store } = setup();

    const results = await Promise.all([
      post(ledger, { idempotencyKey: 'idm_race' }),
      post(ledger, { idempotencyKey: 'idm_race' }),
      post(ledger, { idempotencyKey: 'idm_race' }),
    ]);

    expect(new Set(results.map((journal) => journal.id)).size).toBe(1);
    expect(store.journals.size).toBe(1);
  });

  it('keeps the ledger balanced under concurrent unrelated postings', async () => {
    const { ledger } = setup();

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        post(ledger, { entries: sale('10.00'), idempotencyKey: `idm_${index}` }),
      ),
    );

    const trial = await ledger.trialBalance({ organizationId: 'org_a' });

    expect(trial.balanced).toBe(true);
    expect(formatMoney(trial.totals[0]!.debits)).toBe('500.00 USD');
  });
});

describe('period closing', () => {
  function withPeriods() {
    const store = new InMemoryLedgerStore(currencies);
    const periods = new InMemoryPeriodStore();
    const audit = { record: vi.fn() };

    const ledger = new Ledger({
      store,
      periods,
      currencies,
      audit,
      now: () => clock,
      newId: (prefix) => `${prefix}_${(counter += 1)}`,
    });

    return { store, periods, audit, ledger };
  }

  const march = {
    code: '2026-03',
    startsAt: new Date('2026-03-01T00:00:00.000Z'),
    endsAt: new Date('2026-04-01T00:00:00.000Z'),
  };

  it('refuses a posting into a closed period', async () => {
    /*
     * The failure this prevents: a report run in April for March, sent to somebody who acted on
     * it, and then a journal posted with a March effective date. Nobody re-runs March.
     */
    const { ledger } = withPeriods();

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });
    await ledger.closePeriod({ id: period.id, organizationId: 'org_a', actorId: 'usr_finance' });

    await expect(
      post(ledger, { effectiveAt: new Date('2026-03-15T00:00:00.000Z') }),
    ).rejects.toThrow(/Period 2026-03 .* was closed/);
  });

  it('checks the effective date, not the posting date', async () => {
    // Checking the posting date would be useless — it is always now — and freezing the whole
    // ledger is the other way to get it wrong.
    const { ledger } = withPeriods();

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });
    await ledger.closePeriod({ id: period.id, organizationId: 'org_a' });

    clock = new Date('2026-04-15T00:00:00.000Z');

    // Posted now, effective now: fine, even though March is closed.
    await expect(post(ledger)).resolves.toMatchObject({ status: 'posted' });
  });

  it('says what to do instead of just refusing', async () => {
    const { ledger } = withPeriods();

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });
    await ledger.closePeriod({ id: period.id, organizationId: 'org_a' });

    const error = await caught(() =>
      post(ledger, { effectiveAt: new Date('2026-03-15T00:00:00.000Z') }),
    );

    expect((error as Error).message).toMatch(/Post to the current period with a note/);
  });

  it('records the trial balance at the moment of closing', async () => {
    /*
     * Stored rather than recomputed. Recomputing gives a different answer the moment anything is
     * posted into a reopened period, and the number people need is the one the report they acted
     * on was based on.
     */
    const { ledger } = withPeriods();

    await post(ledger, { effectiveAt: new Date('2026-03-10T00:00:00.000Z') });

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });
    const closed = await ledger.closePeriod({ id: period.id, organizationId: 'org_a' });

    expect(closed.closingTotals).toEqual([
      { currency: 'USD', debits: '100.00', credits: '100.00' },
    ]);
  });

  it('refuses to close a period that does not balance', async () => {
    // Closing a broken period freezes the break, and the report everybody then works from is the
    // wrong one.
    const { ledger, store } = withPeriods();

    const journal = await post(ledger, { effectiveAt: new Date('2026-03-10T00:00:00.000Z') });

    const tampered = structuredClone(store.journals.get(journal.id)!);
    tampered.entries.pop();
    store.journals.set(journal.id, tampered);

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });

    await expect(ledger.closePeriod({ id: period.id, organizationId: 'org_a' })).rejects.toThrow(
      /would freeze the break/,
    );
  });

  it('closes anyway when forced, and records that it was forced', async () => {
    const { ledger, store, audit } = withPeriods();

    const journal = await post(ledger, { effectiveAt: new Date('2026-03-10T00:00:00.000Z') });
    const tampered = structuredClone(store.journals.get(journal.id)!);
    tampered.entries.pop();
    store.journals.set(journal.id, tampered);

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });
    await ledger.closePeriod({ id: period.id, organizationId: 'org_a', force: true });

    const record = audit.record.mock.calls.find(
      (call) => call[0].action === 'ledger.period.closed',
    )!;

    expect(record[0].after).toMatchObject({ forced: true, balanced: false });
  });

  it('reopens loudly, with a reason and a record', async () => {
    /*
     * Refusing outright sounds stricter and is worse: the correction happens anyway, as a journal
     * dated after the close with a description explaining that it belongs in March.
     */
    const { ledger, audit } = withPeriods();

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });
    await ledger.closePeriod({ id: period.id, organizationId: 'org_a' });

    const reopened = await ledger.reopenPeriod({
      id: period.id,
      organizationId: 'org_a',
      reason: 'A supplier invoice arrived three weeks late and belongs in March.',
      actorId: 'usr_finance',
    });

    expect(reopened.status).toBe('open');
    expect(reopened.reopenings).toHaveLength(1);
    expect(reopened.reopenings[0]!.reason).toMatch(/three weeks late/);

    expect(
      audit.record.mock.calls.some((call) => call[0].action === 'ledger.period.reopened'),
    ).toBe(true);

    // And posting into it works again.
    await expect(
      post(ledger, { effectiveAt: new Date('2026-03-15T00:00:00.000Z') }),
    ).resolves.toMatchObject({ status: 'posted' });
  });

  it('requires a reason to reopen', async () => {
    const { ledger } = withPeriods();

    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });
    await ledger.closePeriod({ id: period.id, organizationId: 'org_a' });

    const error = await caught(() =>
      ledger.reopenPeriod({ id: period.id, organizationId: 'org_a', reason: '  ' }),
    );

    expect(detailsOf(error)).toMatch(/only record of why a period somebody already reported on/);
  });

  it('refuses two periods covering the same instant', async () => {
    // A journal would belong to both, and which one a report uses depends on which query ran.
    const { ledger } = withPeriods();

    await ledger.openPeriod({ organizationId: 'org_a', ...march });

    await expect(
      ledger.openPeriod({
        organizationId: 'org_a',
        code: '2026-03-late',
        startsAt: new Date('2026-03-15T00:00:00.000Z'),
        endsAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/overlaps 2026-03/);
  });

  it('lets consecutive periods tile exactly', async () => {
    // The window is half-open, so April starting when March ends is not an overlap.
    const { ledger } = withPeriods();

    await ledger.openPeriod({ organizationId: 'org_a', ...march });

    await expect(
      ledger.openPeriod({
        organizationId: 'org_a',
        code: '2026-04',
        startsAt: new Date('2026-04-01T00:00:00.000Z'),
        endsAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    ).resolves.toBeTruthy();
  });

  it('does not close another tenant’s period', async () => {
    const { ledger } = withPeriods();
    const period = await ledger.openPeriod({ organizationId: 'org_a', ...march });

    await expect(ledger.closePeriod({ id: period.id, organizationId: 'org_b' })).rejects.toThrow(
      /No period with id/,
    );
  });

  it('posts freely when no period store is wired', async () => {
    // The honest default: a framework that invented periods would refuse postings for a reason
    // nobody configured.
    const { ledger } = setup();

    await expect(
      post(ledger, { effectiveAt: new Date('2020-01-01T00:00:00.000Z') }),
    ).resolves.toMatchObject({ status: 'posted' });
  });
});
