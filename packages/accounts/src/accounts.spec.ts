import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustsystem/financial-core';
import { InMemoryLedgerStore, Ledger, credit, debit } from '@trustsystem/ledger';
import {
  NORMAL_SIDE,
  accountCode,
  accountSchema,
  assertWithinOverdraft,
  canPost,
  classFor,
  normalBalance,
} from './account';
import { AccountService } from './service';
import { InMemoryAccountStore } from './testing';

/**
 * The sign tests are the ones worth having.
 *
 * A customer wallet is a liability, so its raw ledger balance is negative when it holds money. Get
 * that backwards and every balance reads correctly in the ledger, incorrectly on the statement,
 * and the bug looks like it is in the ledger.
 */

const currencies = new CurrencyRegistry();
const usd = (amount: string) => money(amount, 'USD', currencies);

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function detailsOf(error: unknown): string {
  const details = (error as { details?: Array<{ message: string }> }).details ?? [];
  return details.map((detail) => detail.message).join(' | ');
}

function setup() {
  const ledgerStore = new InMemoryLedgerStore(currencies);
  const ledger = new Ledger({
    store: ledgerStore,
    currencies,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  const store = new InMemoryAccountStore();
  const audit = { record: vi.fn() };

  const accounts = new AccountService({
    store,
    ledger,
    currencies,
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { accounts, ledger, store, audit };
}

const openCustomer = (accounts: AccountService, overrides: Record<string, unknown> = {}) =>
  accounts.open({
    organizationId: 'org_a',
    code: 'customer.usr_1.usd',
    name: 'Dara — USD',
    type: 'customer',
    currency: 'USD',
    ownerId: 'usr_1',
    ownerType: 'user',
    actorId: 'usr_admin',
    ...overrides,
  });

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('account classes', () => {
  it('knows which side increases each class', () => {
    expect(NORMAL_SIDE.asset).toBe('debit');
    expect(NORMAL_SIDE.expense).toBe('debit');
    expect(NORMAL_SIDE.liability).toBe('credit');
    expect(NORMAL_SIDE.equity).toBe('credit');
    expect(NORMAL_SIDE.revenue).toBe('credit');
  });

  it('makes a customer account a liability', () => {
    // Money a customer deposited is money the business owes. The most consequential line here.
    expect(classFor('customer')).toBe('liability');
    expect(classFor('merchant')).toBe('liability');
    expect(classFor('reserve')).toBe('liability');
    expect(classFor('system')).toBe('asset');
    expect(classFor('fee')).toBe('revenue');
  });

  it('refuses an account declared as the wrong class', () => {
    const result = accountSchema.safeParse({
      id: 'acc_1',
      organizationId: 'org_a',
      code: 'customer.usr_1.usd',
      name: 'x',
      type: 'customer',
      class: 'asset',
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(
      /reports every balance in it with the wrong sign/,
    );
  });

  it('refuses an overdraft limit on an account that cannot go negative', () => {
    const result = accountSchema.safeParse({
      id: 'acc_1',
      organizationId: 'org_a',
      code: 'customer.usr_1.usd',
      name: 'x',
      type: 'customer',
      class: 'liability',
      currency: 'USD',
      allowNegative: false,
      overdraftLimit: '100.00',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.message).toMatch(/can never apply/);
  });

  it('lets a general account declare its own class', () => {
    const result = accountSchema.safeParse({
      id: 'acc_1',
      organizationId: 'org_a',
      code: 'general.rounding.usd',
      name: 'Rounding differences',
      type: 'general',
      class: 'expense',
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(true);
  });
});

describe('balance signs', () => {
  it('reports a customer wallet as positive when it holds money', async () => {
    /*
     * The ledger says -100.00 for this account, because a credit balance on a liability is
     * negative in `debits - credits`. The statement must say 100.00.
     */
    const { accounts, ledger } = setup();
    const customer = await openCustomer(accounts);

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      entries: [debit('acc_bank', usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    const raw = await ledger.balances({ organizationId: 'org_a', accountIds: [customer.id] });

    expect(formatMoney(raw[0]!.balance)).toBe('-100.00 USD');
    expect(formatMoney(await accounts.balance(customer))).toBe('100.00 USD');
  });

  it('reports a system account as positive when it holds money', async () => {
    const { accounts, ledger } = setup();

    const bank = await accounts.open({
      organizationId: 'org_a',
      code: 'system.bank.usd',
      name: 'Operating bank',
      type: 'system',
      currency: 'USD',
    });

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      entries: [debit(bank.id, usd('100.00')), credit('acc_equity', usd('100.00'))],
    });

    expect(formatMoney(await accounts.balance(bank))).toBe('100.00 USD');
  });

  it('reports zero for an account with no postings, rather than nothing', async () => {
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    expect(formatMoney(await accounts.balance(customer))).toBe('0.00 USD');
  });

  it('flips the sign per class in normalBalance', () => {
    expect(formatMoney(normalBalance({ class: 'asset' }, usd('100.00')))).toBe('100.00 USD');
    expect(formatMoney(normalBalance({ class: 'liability' }, usd('-100.00')))).toBe('100.00 USD');
    expect(formatMoney(normalBalance({ class: 'revenue' }, usd('-50.00')))).toBe('50.00 USD');
  });

  it('reads several balances in one query', async () => {
    const { accounts, ledger } = setup();
    const customer = await openCustomer(accounts);
    const second = await openCustomer(accounts, { code: 'customer.usr_2.usd', ownerId: 'usr_2' });

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposits',
      entries: [
        debit('acc_bank', usd('150.00')),
        credit(customer.id, usd('100.00')),
        credit(second.id, usd('50.00')),
      ],
    });

    const balances = await accounts.balances([customer, second]);

    expect(formatMoney(balances.get(customer.id)!)).toBe('100.00 USD');
    expect(formatMoney(balances.get(second.id)!)).toBe('50.00 USD');
  });

  it('refuses a mixed-tenant balance query', async () => {
    // It would scope to the first tenant and silently return zero for the rest.
    const { accounts } = setup();
    const a = await openCustomer(accounts);
    const b = await openCustomer(accounts, { organizationId: 'org_b', code: 'customer.usr_9.usd' });

    await expect(accounts.balances([a, b])).rejects.toThrow(ApiError);
  });
});

describe('opening', () => {
  it('derives the class from the type', async () => {
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    expect(customer.class).toBe('liability');
  });

  it('refuses a duplicate code', async () => {
    // Two rows answering to one code makes which balance you get a function of row order.
    const { accounts } = setup();
    await openCustomer(accounts);

    await expect(openCustomer(accounts)).rejects.toThrow(/already exists in this organization/);
  });

  it('allows the same code in a different tenant', async () => {
    const { accounts } = setup();
    await openCustomer(accounts);

    await expect(openCustomer(accounts, { organizationId: 'org_b' })).resolves.toBeTruthy();
  });

  it('refuses an unconfigured currency before anything is written', async () => {
    const { accounts, store } = setup();

    await expect(openCustomer(accounts, { currency: 'XYZ' })).rejects.toThrow(/Unknown currency/);
    expect(store.accounts.size).toBe(0);
  });

  it('follows one code convention rather than two', () => {
    expect(accountCode('customer', 'usr_1', 'USD')).toBe('customer.usr_1.usd');
    expect(accountCode('fee', 'processing', 'KHR')).toBe('fee.processing.khr');
  });
});

describe('status', () => {
  it('lets money leave a frozen account but not arrive', async () => {
    /*
     * Distinct from blocked. A frozen customer can still be paid out and can still have a
     * settlement completed; conflating the two means every freeze is the harsher one.
     */
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    await accounts.freeze({
      id: customer.id,
      organizationId: 'org_a',
      reason: 'Under review.',
      actorId: 'usr_ops',
    });

    const frozen = await accounts.get(customer.id, 'org_a');

    // A liability decreases on the debit side, which is money leaving.
    expect(canPost(frozen, 'debit').allowed).toBe(true);
    expect(canPost(frozen, 'credit').allowed).toBe(false);
  });

  it('blocks both directions', async () => {
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    await accounts.block({ id: customer.id, organizationId: 'org_a', reason: 'Investigation.' });

    const blocked = await accounts.get(customer.id, 'org_a');

    expect(canPost(blocked, 'debit').allowed).toBe(false);
    expect(canPost(blocked, 'credit').allowed).toBe(false);
  });

  it('requires a reason for a status change', async () => {
    // The only record of why somebody could not spend their own money.
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    try {
      await accounts.freeze({ id: customer.id, organizationId: 'org_a', reason: '   ' });
      expect.unreachable();
    } catch (error) {
      expect(detailsOf(error)).toMatch(/could not spend their own money/);
    }
  });

  it('refuses to post to a frozen account through assertCanPost', async () => {
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    await accounts.freeze({ id: customer.id, organizationId: 'org_a', reason: 'Review.' });

    await expect(accounts.assertCanPost(customer.id, 'org_a', 'credit')).rejects.toThrow(
      /is frozen/,
    );
    await expect(accounts.assertCanPost(customer.id, 'org_a', 'debit')).resolves.toBeTruthy();
  });

  it('does not let one tenant freeze another’s account', async () => {
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    await expect(
      accounts.freeze({ id: customer.id, organizationId: 'org_b', reason: 'x' }),
    ).rejects.toThrow(/No account with id/);
  });
});

describe('closing', () => {
  it('refuses to close an account that still holds money', async () => {
    // A closed account with a balance is an obligation in a record nobody looks at.
    const { accounts, ledger } = setup();
    const customer = await openCustomer(accounts);

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      entries: [debit('acc_bank', usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    await expect(
      accounts.close({ id: customer.id, organizationId: 'org_a', reason: 'Customer left.' }),
    ).rejects.toThrow(/cannot be closed while it holds/);
  });

  it('closes an empty account', async () => {
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    const closed = await accounts.close({
      id: customer.id,
      organizationId: 'org_a',
      reason: 'Customer left.',
    });

    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toEqual(clock);
  });

  it('refuses to change the status of a closed account', async () => {
    const { accounts } = setup();
    const customer = await openCustomer(accounts);

    await accounts.close({ id: customer.id, organizationId: 'org_a', reason: 'Left.' });

    await expect(
      accounts.unfreeze({ id: customer.id, organizationId: 'org_a', reason: 'Back.' }),
    ).rejects.toThrow(/Re-opening is a new account/);
  });
});

describe('overdraft', () => {
  const parse = (value: string) => usd(value);

  it('refuses a negative balance by default', () => {
    // A customer balance that can go negative is an unsecured loan nobody decided to make.
    const account = accountSchema.parse({
      id: 'acc_1',
      organizationId: 'org_a',
      code: 'customer.usr_1.usd',
      name: 'x',
      type: 'customer',
      class: 'liability',
      currency: 'USD',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(() => assertWithinOverdraft(account, usd('-0.01'), parse)).toThrow(ApiError);
    expect(() => assertWithinOverdraft(account, usd('0.00'), parse)).not.toThrow();
  });

  it('allows a negative balance up to the limit and no further', () => {
    const account = accountSchema.parse({
      id: 'acc_1',
      organizationId: 'org_a',
      code: 'system.float.usd',
      name: 'x',
      type: 'system',
      class: 'asset',
      currency: 'USD',
      allowNegative: true,
      overdraftLimit: '500.00',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(() => assertWithinOverdraft(account, usd('-500.00'), parse)).not.toThrow();
    expect(() => assertWithinOverdraft(account, usd('-500.01'), parse)).toThrow(ApiError);
    expect(
      detailsOf(
        (() => {
          try {
            assertWithinOverdraft(account, usd('-500.01'), parse);
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toMatch(/past its overdraft limit of 500.00 USD/);
  });

  it('allows any negative balance when no limit is set', () => {
    const account = accountSchema.parse({
      id: 'acc_1',
      organizationId: 'org_a',
      code: 'system.float.usd',
      name: 'x',
      type: 'system',
      class: 'asset',
      currency: 'USD',
      allowNegative: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(() => assertWithinOverdraft(account, usd('-1000000.00'), parse)).not.toThrow();
  });
});

describe('audit', () => {
  it('records what kind of account was opened', async () => {
    const { accounts, audit } = setup();
    await openCustomer(accounts);

    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'ledger.account.opened',
      organizationId: 'org_a',
      actorId: 'usr_admin',
      after: expect.objectContaining({ type: 'customer', class: 'liability', currency: 'USD' }),
    });
  });

  it('records a freeze with its reason', async () => {
    const { accounts, audit } = setup();
    const customer = await openCustomer(accounts);

    await accounts.freeze({ id: customer.id, organizationId: 'org_a', reason: 'Sanctions check.' });

    expect(audit.record.mock.calls[1]![0]).toMatchObject({
      action: 'ledger.account.frozen',
      before: { status: 'active' },
      after: { status: 'frozen', reason: 'Sanctions check.' },
    });
  });
});
