import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@trustos/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { AccountService, InMemoryAccountStore } from '@trustos/accounts';
import { InMemoryLedgerStore, Ledger } from '@trustos/ledger';
import { InMemoryLimitStore, LimitEngine } from '@trustos/limits';
import { FeeService, InMemoryFeeScheduleStore } from '@trustos/fees';
import { RiskAssessor, type RiskProvider } from '@trustos/financial-risk';
import { InMemoryHoldStore, InMemoryWalletStore, WalletService } from '@trustos/wallet';
import { TRANSITIONS, canTransition } from './transaction';
import { TransactionService } from './service';
import { InMemoryTransactionStore } from './testing';

/**
 * Two things are being tested here and the rest is plumbing.
 *
 * That an illegal transition is refused — the transition nobody thought about is the one that lets
 * a refunded transaction be captured again. And that a retry is one payment, because a client with
 * a 30-second timeout against a service with a 35-second p99 retries a meaningful fraction of
 * everything.
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

async function setup(options: { risk?: RiskProvider[]; withFees?: boolean } = {}) {
  const ledger = new Ledger({
    store: new InMemoryLedgerStore(currencies),
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

  const wallets = new WalletService({
    wallets: new InMemoryWalletStore(),
    holds: new InMemoryHoldStore(),
    ledger,
    accounts,
    limits: new LimitEngine({
      store: new InMemoryLimitStore(currencies),
      currencies,
      now: () => clock,
    }),
    currencies,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  const fees = new FeeService({
    store: new InMemoryFeeScheduleStore(),
    currencies,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  if (options.withFees) {
    const draft = await fees.draft({
      organizationId: 'org_a',
      key: 'payment.standard',
      name: 'Standard',
      currency: 'USD',
      components: [{ name: 'Processing', kind: 'percentage', basisPoints: 250 }],
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    });
    await fees.publish({ id: draft.id, organizationId: 'org_a' });
  }

  const audit = { record: vi.fn() };

  const transactions = new TransactionService({
    store: new InMemoryTransactionStore(),
    ledger,
    wallets,
    accounts,
    fees,
    risk: new RiskAssessor({ providers: options.risk, now: () => clock }),
    currencies,
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  const bank = await accounts.open({
    organizationId: 'org_a',
    code: 'system.bank.usd',
    name: 'Bank',
    type: 'system',
    currency: 'USD',
  });

  const merchantAccount = await accounts.open({
    organizationId: 'org_a',
    code: 'merchant.mer_1.usd',
    name: 'Merchant',
    type: 'merchant',
    currency: 'USD',
  });

  const payer = await wallets.open({ organizationId: 'org_a', ownerId: 'usr_1', currency: 'USD' });

  await wallets.credit({
    walletId: payer.id,
    organizationId: 'org_a',
    amount: usd('1000.00'),
    fromAccountId: bank.id,
    description: 'Opening deposit',
    idempotencyKey: 'seed',
  });

  return { transactions, wallets, accounts, ledger, audit, payer, bank, merchantAccount };
}

const payment = (
  transactions: TransactionService,
  payerWalletId: string,
  merchantAccountId: string,
  overrides: Record<string, unknown> = {},
) =>
  transactions.create({
    organizationId: 'org_a',
    type: 'payment',
    amount: usd('100.00'),
    sourceWalletId: payerWalletId,
    destinationAccountId: merchantAccountId,
    reference: 'ORD-1001',
    description: 'Order ORD-1001',
    actorId: 'usr_1',
    ...overrides,
  });

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('the state machine', () => {
  it('declares every allowed transition', () => {
    // Declared rather than implied: a set of `if (status === ...)` checks spread across a service
    // always has a case nobody thought about.
    expect(canTransition('pending', 'authorized')).toBe(true);
    expect(canTransition('authorized', 'captured')).toBe(true);
    expect(canTransition('captured', 'completed')).toBe(true);
    expect(canTransition('completed', 'refunded')).toBe(true);
  });

  it('makes failure, cancellation and expiry final', () => {
    for (const status of ['failed', 'cancelled', 'expired', 'reversed'] as const) {
      expect(TRANSITIONS[status]).toEqual([]);
    }
  });

  it('refuses to capture a refunded transaction', async () => {
    // The transition nobody thinks about.
    const { transactions, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.capture({ id: created.id, organizationId: 'org_a' });
    await transactions.complete({ id: created.id, organizationId: 'org_a' });
    await transactions.refund({ id: created.id, organizationId: 'org_a', reason: 'Returned.' });

    await expect(transactions.capture({ id: created.id, organizationId: 'org_a' })).rejects.toThrow(
      /is refunded and cannot become captured/,
    );
  });

  it('says what is allowed instead', async () => {
    const { transactions, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await transactions.cancel({ id: created.id, organizationId: 'org_a', reason: 'Changed mind.' });

    const error = await caught(() =>
      transactions.capture({ id: created.id, organizationId: 'org_a' }),
    );

    expect((error as Error).message).toMatch(
      /cancelled is a final state; a correction is a new transaction/,
    );
  });
});

describe('authorization and capture', () => {
  it('holds funds at authorization without moving them', async () => {
    const { transactions, wallets, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    const authorized = await transactions.authorize({ id: created.id, organizationId: 'org_a' });

    expect(authorized.status).toBe('authorized');
    expect(authorized.holdId).toMatch(/^hld_/);

    const balance = await wallets.balance(payer.id, 'org_a');

    expect(formatMoney(balance.total)).toBe('1000.00 USD');
    expect(formatMoney(balance.available)).toBe('900.00 USD');
  });

  it('holds the fee as well as the amount', async () => {
    /*
     * Authorizing the amount and discovering at capture that the fee does not fit is a failure at
     * the worst possible moment.
     */
    const { transactions, wallets, payer, merchantAccount } = await setup({ withFees: true });

    const created = await payment(transactions, payer.id, merchantAccount.id, {
      feeScheduleKey: 'payment.standard',
    });

    await transactions.authorize({ id: created.id, organizationId: 'org_a' });

    const balance = await wallets.balance(payer.id, 'org_a');

    // 100 plus the 2.50 fee.
    expect(formatMoney(balance.held)).toBe('102.50 USD');
  });

  it('moves the money at capture', async () => {
    const { transactions, wallets, accounts, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await transactions.authorize({ id: created.id, organizationId: 'org_a' });
    const { transaction, journals } = await transactions.capture({
      id: created.id,
      organizationId: 'org_a',
    });

    expect(transaction.status).toBe('captured');
    expect(journals).toHaveLength(1);

    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).total)).toBe('900.00 USD');
    expect(
      formatMoney(await accounts.balance(await accounts.get(merchantAccount.id, 'org_a'))),
    ).toBe('100.00 USD');
  });

  it('captures directly from pending, for an internal transfer', async () => {
    // There is nothing to authorize against an internal counterparty.
    const { transactions, wallets, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    const { transaction } = await transactions.capture({ id: created.id, organizationId: 'org_a' });

    expect(transaction.status).toBe('captured');
    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).total)).toBe('900.00 USD');
  });

  it('refuses to authorize a transaction with no source wallet', async () => {
    const { transactions, bank, merchantAccount } = await setup();

    const created = await transactions.create({
      organizationId: 'org_a',
      type: 'deposit',
      amount: usd('50.00'),
      sourceAccountId: bank.id,
      destinationAccountId: merchantAccount.id,
    });

    const error = await caught(() =>
      transactions.authorize({ id: created.id, organizationId: 'org_a' }),
    );

    expect(detailsOf(error)).toMatch(/nothing to hold funds against/);
  });
});

describe('failure and cancellation', () => {
  it('releases the hold when a transaction fails', async () => {
    /*
     * Not a follow-up call. A failed transaction whose hold survives is money the customer cannot
     * spend for a reason that no longer exists.
     */
    const { transactions, wallets, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await transactions.authorize({ id: created.id, organizationId: 'org_a' });
    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).available)).toBe('900.00 USD');

    await transactions.fail({
      id: created.id,
      organizationId: 'org_a',
      reason: 'The provider declined it.',
      code: 'provider_declined',
    });

    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).available)).toBe('1000.00 USD');
  });

  it('releases the hold on cancellation too', async () => {
    const { transactions, wallets, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await transactions.authorize({ id: created.id, organizationId: 'org_a' });
    await transactions.cancel({
      id: created.id,
      organizationId: 'org_a',
      reason: 'Customer changed their mind.',
    });

    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).available)).toBe('1000.00 USD');
  });

  it('does not fail to fail because the hold was already gone', async () => {
    // Otherwise a transaction sits in `authorized` forever with nothing holding anything.
    const { transactions, wallets, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    const authorized = await transactions.authorize({ id: created.id, organizationId: 'org_a' });
    await wallets.release({
      holdId: authorized.holdId!,
      organizationId: 'org_a',
      reason: 'Released out of band.',
    });

    await expect(
      transactions.fail({ id: created.id, organizationId: 'org_a', reason: 'Provider timeout.' }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('expires an authorization nobody captured, releasing the hold', async () => {
    const { transactions, wallets, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await transactions.authorize({
      id: created.id,
      organizationId: 'org_a',
      expiresAt: new Date(clock.getTime() + 60_000),
    });

    clock = new Date(clock.getTime() + 120_000);

    const swept = await transactions.expireStale({ organizationId: 'org_a' });

    expect(swept.expired).toBe(1);
    expect((await transactions.get(created.id, 'org_a')).status).toBe('expired');
    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).available)).toBe('1000.00 USD');
  });
});

describe('idempotency', () => {
  it('returns the same transaction for a retried request', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const first = await payment(transactions, payer.id, merchantAccount.id, {
      idempotencyKey: 'idm_1',
    });
    const second = await payment(transactions, payer.id, merchantAccount.id, {
      idempotencyKey: 'idm_1',
    });

    expect(second.id).toBe(first.id);
    expect(await transactions.list({ organizationId: 'org_a' })).toHaveLength(1);
  });

  it('refuses a key reused for a different payment', async () => {
    /*
     * An idempotency key that returns a *different* transaction's result is worse than none: the
     * caller believes their new payment succeeded and it was somebody else's.
     */
    const { transactions, payer, merchantAccount } = await setup();

    await payment(transactions, payer.id, merchantAccount.id, { idempotencyKey: 'idm_1' });

    await expect(
      payment(transactions, payer.id, merchantAccount.id, {
        idempotencyKey: 'idm_1',
        amount: usd('500.00'),
      }),
    ).rejects.toThrow(/would tell you a different payment succeeded/);
  });

  it('scopes the key to the tenant', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const first = await payment(transactions, payer.id, merchantAccount.id, {
      idempotencyKey: 'idm_1',
    });

    const second = await transactions.create({
      organizationId: 'org_b',
      type: 'payment',
      amount: usd('100.00'),
      sourceAccountId: 'acc_other',
      destinationAccountId: 'acc_other_2',
      idempotencyKey: 'idm_1',
    });

    expect(second.id).not.toBe(first.id);
  });

  it('captures once when the capture is retried', async () => {
    const { transactions, wallets, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await transactions.capture({ id: created.id, organizationId: 'org_a' });

    // The second capture is refused by the state machine, and the ledger's idempotency key would
    // have caught it too.
    await expect(transactions.capture({ id: created.id, organizationId: 'org_a' })).rejects.toThrow(
      ApiError,
    );

    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).total)).toBe('900.00 USD');
  });

  it('creates once under concurrent retries', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        payment(transactions, payer.id, merchantAccount.id, { idempotencyKey: 'idm_race' }),
      ),
    );

    expect(new Set(results.map((transaction) => transaction.id)).size).toBe(1);
  });
});

describe('refunds', () => {
  it('creates a new transaction rather than erasing the original', async () => {
    // The original still happened, and a customer statement that erased it would be wrong.
    const { transactions, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.capture({ id: created.id, organizationId: 'org_a' });
    await transactions.complete({ id: created.id, organizationId: 'org_a' });

    const { original, refund } = await transactions.refund({
      id: created.id,
      organizationId: 'org_a',
      reason: 'Goods returned.',
    });

    expect(refund.id).not.toBe(original.id);
    expect(refund.type).toBe('refund');
    expect(refund.parentTransactionId).toBe(original.id);
    expect(original.status).toBe('refunded');
  });

  it('reverses the direction', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.capture({ id: created.id, organizationId: 'org_a' });
    await transactions.complete({ id: created.id, organizationId: 'org_a' });

    const { refund } = await transactions.refund({
      id: created.id,
      organizationId: 'org_a',
      reason: 'Returned.',
    });

    expect(refund.sourceAccountId).toBe(merchantAccount.id);
    expect(refund.destinationWalletId).toBe(payer.id);
  });

  it('refuses to refund more than was charged, across several refunds', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.capture({ id: created.id, organizationId: 'org_a' });
    await transactions.complete({ id: created.id, organizationId: 'org_a' });

    await transactions.refund({
      id: created.id,
      organizationId: 'org_a',
      amount: usd('60.00'),
      reason: 'Partial return.',
    });

    const error = await caught(() =>
      transactions.refund({
        id: created.id,
        organizationId: 'org_a',
        amount: usd('60.00'),
        reason: 'Second return.',
      }),
    );

    expect(detailsOf(error)).toMatch(
      /100.00 USD was charged and 60.00 USD has already been refunded/,
    );
    expect(detailsOf(error)).toMatch(/leaving 40.00 USD/);
  });

  it('allows a second refund up to the remainder', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.capture({ id: created.id, organizationId: 'org_a' });
    await transactions.complete({ id: created.id, organizationId: 'org_a' });

    await transactions.refund({
      id: created.id,
      organizationId: 'org_a',
      amount: usd('60.00'),
      reason: 'Partial.',
    });

    await expect(
      transactions.refund({
        id: created.id,
        organizationId: 'org_a',
        amount: usd('40.00'),
        reason: 'The rest.',
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses to refund an uncaptured transaction', async () => {
    // An uncaptured transaction is cancelled; a captured one is reversed.
    const { transactions, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await expect(
      transactions.refund({ id: created.id, organizationId: 'org_a', reason: 'Too early.' }),
    ).rejects.toThrow(/Only a completed transaction can be refunded/);
  });
});

describe('reversal', () => {
  it('posts a mirror journal and keeps both records', async () => {
    const { transactions, wallets, payer, merchantAccount, ledger } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.capture({ id: created.id, organizationId: 'org_a' });

    const { transaction, journals } = await transactions.reverse({
      id: created.id,
      organizationId: 'org_a',
      reason: 'Posted in error.',
    });

    expect(transaction.status).toBe('reversed');
    expect(journals).toHaveLength(1);

    expect(formatMoney((await wallets.balance(payer.id, 'org_a')).total)).toBe('1000.00 USD');

    const trial = await ledger.trialBalance({ organizationId: 'org_a' });
    expect(trial.balanced).toBe(true);
  });
});

describe('risk', () => {
  it('fails a declined transaction immediately rather than leaving it pending', async () => {
    /*
     * A declined transaction that sits in `pending` is indistinguishable on every screen from one
     * waiting for a provider.
     */
    const sanctions: RiskProvider = {
      name: 'sanctions-provider',
      kind: 'sanctions',
      assess: async () => ({
        kind: 'sanctions' as const,
        source: 'sanctions-provider',
        score: 100,
        detail: 'Name matches a sanctions list entry.',
        decisive: true,
      }),
    };

    const { transactions, payer, merchantAccount } = await setup({ risk: [sanctions] });

    const created = await payment(transactions, payer.id, merchantAccount.id);

    expect(created.status).toBe('failed');
    expect(created.failureCode).toBe('risk_declined');
    expect(created.riskDecision).toBe('decline');
  });

  it('records a review decision without stopping the transaction', async () => {
    const velocity: RiskProvider = {
      name: 'velocity',
      kind: 'velocity',
      assess: async () => ({
        kind: 'velocity' as const,
        source: 'velocity',
        score: 60,
        detail: 'Five payments in ten minutes.',
        decisive: false,
      }),
    };

    const { transactions, payer, merchantAccount } = await setup({ risk: [velocity] });

    const created = await payment(transactions, payer.id, merchantAccount.id);

    expect(created.status).toBe('pending');
    expect(created.riskDecision).toBe('review');
    expect(created.riskScore).toBe(60);
  });

  it('approves and says nothing was checked when no provider is wired', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);

    expect(created.riskDecision).toBe('approve');
    expect(created.riskScore).toBe(0);
  });
});

describe('validation', () => {
  it('refuses a negative amount', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const error = await caught(() =>
      payment(transactions, payer.id, merchantAccount.id, { amount: usd('-100.00') }),
    );

    expect(detailsOf(error)).toMatch(/bypasses every balance check/);
  });

  it('refuses a transaction with neither end', async () => {
    // It can never post a journal, so it sits in pending forever.
    const { transactions } = await setup();

    await expect(
      transactions.create({ organizationId: 'org_a', type: 'payment', amount: usd('1.00') }),
    ).rejects.toThrow();
  });

  it('does not let one tenant act on another’s transaction', async () => {
    const { transactions, payer, merchantAccount } = await setup();
    const created = await payment(transactions, payer.id, merchantAccount.id);

    await expect(transactions.capture({ id: created.id, organizationId: 'org_b' })).rejects.toThrow(
      /No transaction with id/,
    );
  });
});

describe('history and audit', () => {
  it('records every step, with the journal it produced', async () => {
    const { transactions, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.authorize({ id: created.id, organizationId: 'org_a' });
    await transactions.capture({ id: created.id, organizationId: 'org_a' });
    await transactions.complete({ id: created.id, organizationId: 'org_a' });

    const history = await transactions.history(created.id, 'org_a');

    expect(history.map((event) => event.to)).toEqual([
      'pending',
      'authorized',
      'captured',
      'completed',
    ]);
    expect(history[2]!.journalId).toMatch(/^jrn_/);
  });

  it('audits each state change with the amount', async () => {
    const { transactions, audit, payer, merchantAccount } = await setup();

    const created = await payment(transactions, payer.id, merchantAccount.id);
    await transactions.capture({ id: created.id, organizationId: 'org_a' });

    const record = audit.record.mock.calls.find(
      (call) => call[0].action === 'transactions.transaction.captured',
    )!;

    expect(record[0]).toMatchObject({
      organizationId: 'org_a',
      before: { status: 'pending' },
      after: expect.objectContaining({ status: 'captured', amount: '100.00 USD' }),
    });
  });
});
