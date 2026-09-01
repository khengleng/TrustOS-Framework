import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustsystem/financial-core';
import { AccountService, InMemoryAccountStore } from '@trustsystem/accounts';
import { InMemoryLedgerStore, Ledger } from '@trustsystem/ledger';
import { InMemoryLimitStore, LimitEngine, limitSchema } from '@trustsystem/limits';
import { WalletService } from './service';
import { holdSchema } from './wallet';
import { InMemoryHoldStore, InMemoryWalletStore } from './testing';

/**
 * The hold tests are what this file is for.
 *
 * A system with only a total balance authorizes the same money twice: the first authorization has
 * not moved anything, so the second one sees the whole balance. Every test below that mentions
 * `available` is really testing that.
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

function setup(options: { withLimits?: boolean } = {}) {
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

  const limitStore = new InMemoryLimitStore(currencies);

  if (options.withLimits) {
    limitStore.add(
      limitSchema.parse({
        id: 'lmt_1',
        organizationId: 'org_a',
        key: 'wallet.daily.usd',
        name: 'daily wallet',
        scope: 'wallet',
        window: 'day',
        currency: 'USD',
        maxAmount: '500.00',
        createdAt: clock,
        updatedAt: clock,
      }),
    );
  }

  const audit = { record: vi.fn() };

  const wallets = new WalletService({
    wallets: new InMemoryWalletStore(),
    holds: new InMemoryHoldStore(),
    ledger,
    accounts,
    limits: new LimitEngine({ store: limitStore, currencies, now: () => clock }),
    currencies,
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { wallets, ledger, accounts, audit };
}

async function funded(amount = '1000.00', options: { withLimits?: boolean } = {}) {
  const context = setup(options);

  const bank = await context.accounts.open({
    organizationId: 'org_a',
    code: 'system.bank.usd',
    name: 'Bank',
    type: 'system',
    currency: 'USD',
  });

  const wallet = await context.wallets.open({
    organizationId: 'org_a',
    ownerId: 'usr_1',
    currency: 'USD',
    limitKeys: options.withLimits ? ['wallet.daily.usd'] : [],
    actorId: 'usr_admin',
  });

  // Zero is not a movement, so an empty wallet is simply not credited.
  if (amount !== '0.00') {
    await context.wallets.credit({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd(amount),
      fromAccountId: bank.id,
      description: 'Opening deposit',
      idempotencyKey: 'seed',
    });
  }

  return { ...context, wallet, bank };
}

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('opening', () => {
  it('creates the wallet and the account behind it', async () => {
    // A wallet without its account is a wallet whose balance query fails.
    const { wallets, accounts } = setup();

    const wallet = await wallets.open({
      organizationId: 'org_a',
      ownerId: 'usr_1',
      currency: 'USD',
    });

    const account = await accounts.get(wallet.accountId, 'org_a');

    expect(account.type).toBe('customer');
    expect(account.class).toBe('liability');
    expect(account.currency).toBe('USD');
  });

  it('refuses a second wallet in the same currency for one owner', async () => {
    // "The customer's USD balance" would then have two answers.
    const { wallets } = setup();

    await wallets.open({ organizationId: 'org_a', ownerId: 'usr_1', currency: 'USD' });

    await expect(
      wallets.open({ organizationId: 'org_a', ownerId: 'usr_1', currency: 'USD' }),
    ).rejects.toThrow(/already has a USD wallet/);
  });

  it('allows one wallet per currency', async () => {
    const { wallets } = setup();

    await wallets.open({ organizationId: 'org_a', ownerId: 'usr_1', currency: 'USD' });

    await expect(
      wallets.open({ organizationId: 'org_a', ownerId: 'usr_1', currency: 'KHR' }),
    ).resolves.toBeTruthy();
  });
});

describe('balances', () => {
  it('reads from the ledger rather than a column', async () => {
    /*
     * A wallet with its own balance column has two sources of truth. This test is really checking
     * that there is no column: the balance follows a journal posted directly to the account.
     */
    const { wallets, wallet, bank, ledger } = await funded('100.00');

    await ledger.post({
      organizationId: 'org_a',
      description: 'Direct posting, behind the wallet service',
      entries: [
        {
          accountId: bank.id,
          direction: 'debit',
          amount: { currency: 'USD', amount: '50.00' },
          description: '',
          dimension: null,
          metadata: {},
        },
        {
          accountId: wallet.accountId,
          direction: 'credit',
          amount: { currency: 'USD', amount: '50.00' },
          description: '',
          dimension: null,
          metadata: {},
        },
      ],
    });

    const balance = await wallets.balance(wallet.id, 'org_a');

    expect(formatMoney(balance.total)).toBe('150.00 USD');
  });

  it('reports total, held and available separately', async () => {
    const { wallets, wallet } = await funded('1000.00');

    await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Card authorization',
    });

    const balance = await wallets.balance(wallet.id, 'org_a');

    expect(formatMoney(balance.total)).toBe('1000.00 USD');
    expect(formatMoney(balance.held)).toBe('300.00 USD');
    expect(formatMoney(balance.available)).toBe('700.00 USD');
    expect(balance.holdCount).toBe(1);
  });
});

describe('holds', () => {
  it('stops the same money being authorized twice', async () => {
    /*
     * The whole reason holds exist. With only a total balance, the second authorization sees the
     * full 1000 because the first has not moved anything.
     */
    const { wallets, wallet } = await funded('1000.00');

    await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('800.00'),
      reason: 'First authorization',
    });

    const error = await caught(() =>
      wallets.hold({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('800.00'),
        reason: 'Second authorization',
      }),
    );

    expect(detailsOf(error)).toMatch(/exceeds the available balance of 200.00 USD by 600.00 USD/);
    expect(detailsOf(error)).toMatch(/800.00 USD is held against 1 pending operation/);
  });

  it('moves nothing when a hold is placed', async () => {
    // A hold is a promise, not a movement.
    const { wallets, wallet, ledger } = await funded('1000.00');

    await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Authorization',
    });

    const journals = await ledger.list({ organizationId: 'org_a' });

    expect(journals).toHaveLength(1); // Only the opening deposit.
  });

  it('captures a hold and moves the money', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Authorization',
    });

    const result = await wallets.capture({
      holdId: hold.id,
      organizationId: 'org_a',
      toAccountId: bank.id,
      description: 'Card capture',
    });

    expect(result.hold.status).toBe('captured');
    expect(formatMoney(result.balance.total)).toBe('700.00 USD');
    expect(formatMoney(result.balance.available)).toBe('700.00 USD');
  });

  it('captures a hold on a wallet whose whole balance is held', async () => {
    /*
     * The bug this catches: the hold being captured must not count against availability, or every
     * capture fails on a wallet where the authorization covers the whole balance — which is the
     * normal case.
     */
    const { wallets, wallet, bank } = await funded('100.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('100.00'),
      reason: 'Authorization for the full balance',
    });

    await expect(
      wallets.capture({
        holdId: hold.id,
        organizationId: 'org_a',
        toAccountId: bank.id,
        description: 'Capture',
      }),
    ).resolves.toMatchObject({ hold: expect.objectContaining({ status: 'captured' }) });
  });

  it('leaves the remainder held after a partial capture', async () => {
    // An authorization for an estimate, captured for the final amount, usually has a second
    // capture coming.
    const { wallets, wallet, bank } = await funded('1000.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Estimate',
    });

    const result = await wallets.capture({
      holdId: hold.id,
      organizationId: 'org_a',
      amount: usd('120.00'),
      toAccountId: bank.id,
      description: 'Final amount',
      idempotencyKey: 'cap_1',
    });

    expect(result.hold.status).toBe('active');
    expect(formatMoney(result.balance.held)).toBe('180.00 USD');
    expect(formatMoney(result.balance.total)).toBe('880.00 USD');
  });

  it('refuses to capture more than was authorized', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('100.00'),
      reason: 'Authorization',
    });

    const error = await caught(() =>
      wallets.capture({
        holdId: hold.id,
        organizationId: 'org_a',
        amount: usd('150.00'),
        toAccountId: bank.id,
        description: 'Too much',
      }),
    );

    expect(detailsOf(error)).toMatch(/a second transaction, not a capture/);
  });

  it('releases a hold without moving money', async () => {
    const { wallets, wallet, ledger } = await funded('1000.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Authorization',
    });

    await wallets.release({
      holdId: hold.id,
      organizationId: 'org_a',
      reason: 'Customer cancelled.',
    });

    const balance = await wallets.balance(wallet.id, 'org_a');

    expect(formatMoney(balance.available)).toBe('1000.00 USD');
    expect(await ledger.list({ organizationId: 'org_a' })).toHaveLength(1);
  });

  it('refuses to release a hold twice', async () => {
    // The second release would give back money that is no longer held.
    const { wallets, wallet } = await funded('1000.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Authorization',
    });

    await wallets.release({ holdId: hold.id, organizationId: 'org_a', reason: 'Cancelled.' });

    await expect(
      wallets.release({ holdId: hold.id, organizationId: 'org_a', reason: 'Again.' }),
    ).rejects.toThrow(/already released/);
  });

  it('refuses to capture a released hold', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Authorization',
    });

    await wallets.release({ holdId: hold.id, organizationId: 'org_a', reason: 'Cancelled.' });

    await expect(
      wallets.capture({
        holdId: hold.id,
        organizationId: 'org_a',
        toAccountId: bank.id,
        description: 'Too late',
      }),
    ).rejects.toThrow(/money that was already given back/);
  });
});

describe('expiring holds', () => {
  it('releases a hold nobody captured', async () => {
    /*
     * Without the sweeper, a hold against a process that died is money the customer cannot spend
     * and nobody is coming back for.
     */
    const { wallets, wallet } = await funded('1000.00');

    await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Authorization',
      expiresAt: new Date(clock.getTime() + 60_000),
    });

    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).available)).toBe('700.00 USD');

    clock = new Date(clock.getTime() + 120_000);

    const swept = await wallets.sweepExpiredHolds({ organizationId: 'org_a' });

    expect(swept.released).toBe(1);
    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).available)).toBe('1000.00 USD');
  });

  it('leaves an unexpired hold alone', async () => {
    const { wallets, wallet } = await funded('1000.00');

    await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Authorization',
    });

    expect((await wallets.sweepExpiredHolds({ organizationId: 'org_a' })).released).toBe(0);
  });

  it('gives every hold an expiry, with no way to opt out', async () => {
    const { wallets, wallet } = await funded('1000.00');

    const { hold } = await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('1.00'),
      reason: 'Authorization',
    });

    expect(hold.expiresAt.getTime()).toBe(clock.getTime() + 7 * 86_400_000);
  });
});

describe('debits and credits', () => {
  it('refuses a debit the available balance cannot cover', async () => {
    const { wallets, wallet, bank } = await funded('100.00');

    const error = await caught(() =>
      wallets.debit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('150.00'),
        toAccountId: bank.id,
        description: 'Too much',
      }),
    );

    expect(detailsOf(error)).toMatch(/exceeds the available balance of 100.00 USD by 50.00 USD/);
  });

  it('refuses a negative amount rather than treating it as the other direction', async () => {
    // A negative credit is a debit written backwards, and it would skip the balance check.
    const { wallets, wallet, bank } = await funded('100.00');

    const error = await caught(() =>
      wallets.credit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('-50.00'),
        fromAccountId: bank.id,
        description: 'Sneaky',
      }),
    );

    expect(detailsOf(error)).toMatch(/is not a movement/);
  });

  it('refuses a movement in the wrong currency', async () => {
    const { wallets, wallet, bank } = await funded('100.00');

    const error = await caught(() =>
      wallets.credit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: money('400000', 'KHR', currencies),
        fromAccountId: bank.id,
        description: 'Wrong currency',
      }),
    );

    expect(detailsOf(error)).toMatch(/holds USD and the amount is KHR/);
  });

  it('does not double-post a retried debit', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    await wallets.debit({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('100.00'),
      toAccountId: bank.id,
      description: 'Payment',
      idempotencyKey: 'txn_1',
    });

    await wallets.debit({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('100.00'),
      toAccountId: bank.id,
      description: 'Payment',
      idempotencyKey: 'txn_1',
    });

    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).total)).toBe('900.00 USD');
  });

  it('does not let one tenant move another’s wallet', async () => {
    const { wallets, wallet, bank } = await funded('100.00');

    await expect(
      wallets.debit({
        walletId: wallet.id,
        organizationId: 'org_b',
        amount: usd('10.00'),
        toAccountId: bank.id,
        description: 'Theft',
      }),
    ).rejects.toThrow(/No wallet with id/);
  });
});

describe('limits', () => {
  it('refuses a debit past the wallet limit', async () => {
    const { wallets, wallet, bank } = await funded('1000.00', { withLimits: true });

    const error = await caught(() =>
      wallets.debit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('600.00'),
        toAccountId: bank.id,
        description: 'Over the daily limit',
        idempotencyKey: 'txn_1',
      }),
    );

    expect(detailsOf(error)).toMatch(/past its 500.00 USD ceiling/);
  });

  it('accumulates across debits in the window', async () => {
    const { wallets, wallet, bank } = await funded('1000.00', { withLimits: true });

    await wallets.debit({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      toAccountId: bank.id,
      description: 'First',
      idempotencyKey: 'txn_1',
    });

    await expect(
      wallets.debit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('300.00'),
        toAccountId: bank.id,
        description: 'Second',
        idempotencyKey: 'txn_2',
      }),
    ).rejects.toThrow(ApiError);
  });
});

describe('freezing', () => {
  it('lets money out and not in', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    await wallets.freeze({
      walletId: wallet.id,
      organizationId: 'org_a',
      reason: 'Sanctions check.',
    });

    await expect(
      wallets.credit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('10.00'),
        fromAccountId: bank.id,
        description: 'Deposit',
      }),
    ).rejects.toThrow(/is frozen/);

    await expect(
      wallets.debit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('10.00'),
        toAccountId: bank.id,
        description: 'Payout',
        idempotencyKey: 'out_1',
      }),
    ).resolves.toBeTruthy();
  });

  it('freezes the account behind it, so the two cannot disagree', async () => {
    const { wallets, wallet, accounts } = await funded('100.00');

    await wallets.freeze({ walletId: wallet.id, organizationId: 'org_a', reason: 'Review.' });

    expect((await accounts.get(wallet.accountId, 'org_a')).status).toBe('frozen');
  });

  it('unfreezes both', async () => {
    const { wallets, wallet, accounts } = await funded('100.00');

    await wallets.freeze({ walletId: wallet.id, organizationId: 'org_a', reason: 'Review.' });
    await wallets.unfreeze({ walletId: wallet.id, organizationId: 'org_a', reason: 'Cleared.' });

    expect((await wallets.get(wallet.id, 'org_a')).status).toBe('active');
    expect((await accounts.get(wallet.accountId, 'org_a')).status).toBe('active');
  });

  it('records why, because it is the only record of it', async () => {
    const { wallets, wallet, audit } = await funded('100.00');

    await wallets.freeze({
      walletId: wallet.id,
      organizationId: 'org_a',
      reason: 'Sanctions check.',
      actorId: 'usr_ops',
    });

    const record = audit.record.mock.calls.find((call) => call[0].action === 'wallet.frozen')!;

    expect(record[0]).toMatchObject({
      actorId: 'usr_ops',
      after: { status: 'frozen', reason: 'Sanctions check.' },
    });
  });
});

describe('history', () => {
  it('returns every journal that touched the wallet', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    await wallets.debit({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('100.00'),
      toAccountId: bank.id,
      description: 'Payment',
      idempotencyKey: 'txn_1',
    });

    const history = await wallets.history({ walletId: wallet.id, organizationId: 'org_a' });

    expect(history.map((journal) => journal.description)).toEqual(['Opening deposit', 'Payment']);
  });
});

describe('concurrency', () => {
  it('does not let a retried credit arrive twice', async () => {
    const { wallets, wallet, bank } = await funded('0.00');

    await Promise.all(
      Array.from({ length: 5 }, () =>
        wallets.credit({
          walletId: wallet.id,
          organizationId: 'org_a',
          amount: usd('100.00'),
          fromAccountId: bank.id,
          description: 'Deposit',
          idempotencyKey: 'dep_1',
        }),
      ),
    );

    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).total)).toBe('100.00 USD');
  });
});

describe('reserves', () => {
  it('reduces the available balance without expiring', async () => {
    /*
     * A rolling reserve against chargebacks. It behaves like a hold in that the money cannot be
     * spent, and unlike one in that nothing will ever release it on a timer.
     */
    const { wallets, wallet } = await funded('1000.00');

    const { balance } = await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve: 20% of monthly volume against chargebacks.',
    });

    expect(formatMoney(balance.total)).toBe('1000.00 USD');
    expect(formatMoney(balance.reserved)).toBe('200.00 USD');
    expect(formatMoney(balance.held)).toBe('0.00 USD');
    expect(formatMoney(balance.available)).toBe('800.00 USD');
    expect(balance.reserveCount).toBe(1);
  });

  it('reports held and reserved separately', async () => {
    // They have opposite lifecycles, and a single number cannot say which one is a bug.
    const { wallets, wallet } = await funded('1000.00');

    await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve.',
    });

    await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('300.00'),
      reason: 'Card authorization.',
    });

    const balance = await wallets.balance(wallet.id, 'org_a');

    expect(formatMoney(balance.held)).toBe('300.00 USD');
    expect(formatMoney(balance.reserved)).toBe('200.00 USD');
    expect(formatMoney(balance.available)).toBe('500.00 USD');
    expect(balance.holdCount).toBe(1);
    expect(balance.reserveCount).toBe(1);
  });

  it('is never touched by the sweeper', async () => {
    /*
     * The failure this prevents: a sweeper that dissolves somebody's chargeback reserve because
     * it looked like an old hold.
     */
    const { wallets, wallet } = await funded('1000.00');

    await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve.',
    });

    clock = new Date(clock.getTime() + 365 * 86_400_000);

    expect((await wallets.sweepExpiredHolds({ organizationId: 'org_a' })).released).toBe(0);
    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).reserved)).toBe('200.00 USD');
  });

  it('refuses a reserve with an expiry', async () => {
    // A reserve that expired on a timer would be one that silently stopped covering anything.
    expect(() =>
      holdSchema.parse({
        id: 'hld_1',
        organizationId: 'org_a',
        walletId: 'wlt_1',
        amount: { currency: 'USD', amount: '100.00' },
        kind: 'reserve',
        reason: 'x',
        expiresAt: new Date(),
        createdAt: new Date(),
      }),
    ).toThrow(/A reserve does not expire/);
  });

  it('refuses a hold with no expiry', async () => {
    expect(() =>
      holdSchema.parse({
        id: 'hld_1',
        organizationId: 'org_a',
        walletId: 'wlt_1',
        amount: { currency: 'USD', amount: '100.00' },
        kind: 'hold',
        reason: 'x',
        expiresAt: null,
        createdAt: new Date(),
      }),
    ).toThrow(/A standing floor is a reserve, not a hold/);
  });

  it('refuses to release a reserve through the hold path', async () => {
    // This is the method a cancellation handler and a sweeper call.
    const { wallets, wallet } = await funded('1000.00');

    const { reserve } = await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve.',
    });

    const error = await caught(() =>
      wallets.release({ holdId: reserve.id, organizationId: 'org_a', reason: 'Oops.' }),
    );

    expect(detailsOf(error)).toMatch(/is a reserve, not a hold/);
    expect(detailsOf(error)).toMatch(/not something a cancellation handler does/);
  });

  it('refuses to capture a reserve', async () => {
    // A reserve covers a future obligation; capturing one spends a floor that exists to stay there.
    const { wallets, wallet, bank } = await funded('1000.00');

    const { reserve } = await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve.',
    });

    const error = await caught(() =>
      wallets.capture({
        holdId: reserve.id,
        organizationId: 'org_a',
        toAccountId: bank.id,
        description: 'Nope',
      }),
    );

    expect(detailsOf(error)).toMatch(/spend a floor that exists to stay there/);
  });

  it('releases deliberately, with a reason', async () => {
    const { wallets, wallet, audit } = await funded('1000.00');

    const { reserve } = await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve.',
    });

    await wallets.releaseReserve({
      reserveId: reserve.id,
      organizationId: 'org_a',
      reason: 'Merchant graduated to unreserved terms after twelve clean months.',
      actorId: 'usr_risk',
    });

    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).available)).toBe('1000.00 USD');

    const record = audit.record.mock.calls.find(
      (call) => call[0].action === 'wallet.reserve.released',
    )!;

    expect(record[0].after).toMatchObject({ reason: expect.stringMatching(/twelve clean months/) });
  });

  it('requires a reason to release', async () => {
    // Without one the next person cannot tell whether the risk it covered is gone.
    const { wallets, wallet } = await funded('1000.00');

    const { reserve } = await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve.',
    });

    const error = await caught(() =>
      wallets.releaseReserve({ reserveId: reserve.id, organizationId: 'org_a', reason: ' ' }),
    );

    expect(detailsOf(error)).toMatch(/whether the risk it covered is gone/);
  });

  it('stops a debit that would eat into the reserve', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve.',
    });

    const error = await caught(() =>
      wallets.debit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('900.00'),
        toAccountId: bank.id,
        description: 'Payout',
        idempotencyKey: 'out_1',
      }),
    );

    expect(detailsOf(error)).toMatch(/exceeds the available balance of 800.00 USD/);
    expect(detailsOf(error)).toMatch(/200.00 USD is reserved across 1 standing reserve\(s\)/);
  });

  it('lists the reserves and why each is there', async () => {
    const { wallets, wallet } = await funded('1000.00');

    await wallets.reserve({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('200.00'),
      reason: 'Rolling reserve: 20% of monthly volume.',
    });

    await wallets.hold({
      walletId: wallet.id,
      organizationId: 'org_a',
      amount: usd('50.00'),
      reason: 'Authorization.',
    });

    const reserves = await wallets.reserves(wallet.id, 'org_a');

    expect(reserves).toHaveLength(1);
    expect(reserves[0]!.reason).toMatch(/20% of monthly volume/);
  });
});

describe('load and concurrency', () => {
  it('keeps the balance exact across a thousand movements', async () => {
    // Accumulation: a balance that is right once and drifts over a thousand postings.
    const { wallets, wallet, bank } = await funded('0.00');

    for (let index = 0; index < 500; index += 1) {
      await wallets.credit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('0.07'),
        fromAccountId: bank.id,
        description: 'Micro-deposit',
        idempotencyKey: `in_${index}`,
      });
    }

    for (let index = 0; index < 500; index += 1) {
      await wallets.debit({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('0.03'),
        toAccountId: bank.id,
        description: 'Micro-payment',
        idempotencyKey: `out_${index}`,
      });
    }

    // 500 × 0.07 − 500 × 0.03 = 20.00, exactly.
    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).total)).toBe('20.00 USD');
  }, 20_000);

  it('handles a hundred holds and releases without losing availability', async () => {
    const { wallets, wallet } = await funded('1000.00');

    const holds = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        wallets.hold({
          walletId: wallet.id,
          organizationId: 'org_a',
          amount: usd('1.00'),
          reason: `Authorization ${index}`,
        }),
      ),
    );

    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).held)).toBe('100.00 USD');

    for (const { hold } of holds) {
      await wallets.release({ holdId: hold.id, organizationId: 'org_a', reason: 'Cancelled.' });
    }

    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).available)).toBe('1000.00 USD');
  }, 20_000);

  it('does not double-spend when the same debit is retried five hundred times at once', async () => {
    const { wallets, wallet, bank } = await funded('1000.00');

    await Promise.all(
      Array.from({ length: 500 }, () =>
        wallets.debit({
          walletId: wallet.id,
          organizationId: 'org_a',
          amount: usd('100.00'),
          toAccountId: bank.id,
          description: 'Retried payment',
          idempotencyKey: 'storm',
        }),
      ),
    );

    expect(formatMoney((await wallets.balance(wallet.id, 'org_a')).total)).toBe('900.00 USD');
  }, 20_000);

  it('lets two concurrent holds both pass, which is why the store must be atomic', async () => {
    /*
     * Documented rather than fixed here, and worth a test so the limitation is not rediscovered.
     *
     * `hold` reads the balance and then writes, and two callers reading the same number both see
     * room — the same shape as `LimitEngine.check`. The in-memory store has no lock, so this is
     * what it does.
     *
     * A production `HoldStore` closes it, and the only way to close it is at the database: insert
     * the hold and re-check the balance in one transaction, or take a row lock on the wallet. An
     * implementation that does neither passes every single-threaded test and lets a customer
     * authorize the same money twice.
     */
    const { wallets, wallet } = await funded('100.00');

    const results = await Promise.allSettled([
      wallets.hold({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('100.00'),
        reason: 'First',
      }),
      wallets.hold({
        walletId: wallet.id,
        organizationId: 'org_a',
        amount: usd('100.00'),
        reason: 'Second',
      }),
    ]);

    // Both succeed against this store. That is the race, stated plainly.
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    // And the consequence is visible: the wallet is over-held.
    const balance = await wallets.balance(wallet.id, 'org_a');

    expect(formatMoney(balance.held)).toBe('200.00 USD');
    expect(formatMoney(balance.available)).toBe('-100.00 USD');
  });
});
