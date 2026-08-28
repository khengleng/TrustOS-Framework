import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { AccountService, InMemoryAccountStore } from '@trustos/accounts';
import { InMemoryLedgerStore, Ledger } from '@trustos/ledger';
import { InMemoryLimitStore, LimitEngine } from '@trustos/limits';
import { InMemoryHoldStore, InMemoryWalletStore, WalletService } from '@trustos/wallet';
import { InMemoryTransactionStore, TransactionService } from '@trustos/transactions';
import { PaymentService, paymentRequestSchema } from './payment-request';
import { InMemoryPaymentRequestStore } from './testing';

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

async function setup(options: { onStatusChange?: () => Promise<void> } = {}) {
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

  const transactions = new TransactionService({
    store: new InMemoryTransactionStore(),
    ledger,
    wallets,
    accounts,
    currencies,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  const audit = { record: vi.fn() };
  const store = new InMemoryPaymentRequestStore();

  const payments = new PaymentService({
    store,
    transactions,
    currencies,
    audit,
    ...(options.onStatusChange ? { onStatusChange: options.onStatusChange } : {}),
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

  const merchant = await accounts.open({
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
    description: 'Deposit',
    idempotencyKey: 'seed',
  });

  return { payments, transactions, wallets, audit, store, payer, merchant };
}

const request = (
  payments: PaymentService,
  merchantAccountId: string,
  overrides: Record<string, unknown> = {},
) =>
  payments.create({
    organizationId: 'org_a',
    amount: usd('100.00'),
    payeeAccountId: merchantAccountId,
    invoiceReference: 'INV-2001',
    description: 'Invoice INV-2001',
    actorId: 'usr_merchant',
    ...overrides,
  });

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('creating', () => {
  it('generates a reference people can read aloud', async () => {
    const { payments, merchant } = await setup();
    const created = await request(payments, merchant.id);

    expect(created.reference).toMatch(/^PAY-[34679ACDEFGHJKMNPQRTUVWXY]{12}$/);
  });

  it('gives every request an expiry, with no way to opt out', async () => {
    /*
     * A request with no expiry is a claim that can be paid a year later at a price nobody honours,
     * and it sits in every outstanding-receivables report forever.
     */
    const { payments, merchant } = await setup();
    const created = await request(payments, merchant.id);

    expect(created.expiresAt.getTime()).toBe(clock.getTime() + 86_400_000);
  });

  it('refuses a request with no payee', async () => {
    // The money would arrive with nowhere to go, and the request is payable until somebody pays it.
    const { payments } = await setup();

    const error = await caught(() =>
      payments.create({ organizationId: 'org_a', amount: usd('100.00') }),
    );

    expect(detailsOf(error)).toMatch(/needs a payee/);
  });

  it('accepts a wallet payee as well as an account', async () => {
    const { payments, payer } = await setup();

    await expect(
      payments.create({
        organizationId: 'org_a',
        amount: usd('100.00'),
        payeeWalletId: payer.id,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('paying', () => {
  it('raises a transaction against the request', async () => {
    const { payments, transactions, merchant, payer } = await setup();
    const created = await request(payments, merchant.id);

    const { request: updated, transactionId } = await payments.pay({
      id: created.id,
      organizationId: 'org_a',
      payerWalletId: payer.id,
    });

    expect(updated.status).toBe('processing');
    expect(updated.transactionIds).toEqual([transactionId]);

    const transaction = await transactions.get(transactionId, 'org_a');

    expect(transaction.type).toBe('payment');
    expect(transaction.reference).toBe(created.reference);
  });

  it('pays once when the payer submits twice', async () => {
    /*
     * A payer on a slow connection presses the button again. The version without this takes the
     * money twice and is discovered by the customer.
     */
    const { payments, merchant, payer } = await setup();
    const created = await request(payments, merchant.id);

    const first = await payments.pay({
      id: created.id,
      organizationId: 'org_a',
      payerWalletId: payer.id,
    });

    const second = await payments.pay({
      id: created.id,
      organizationId: 'org_a',
      payerWalletId: payer.id,
    });

    expect(second.transactionId).toBe(first.transactionId);
    expect((await payments.get(created.id, 'org_a')).transactionIds).toHaveLength(1);
  });

  it('refuses to pay an expired request even before the sweeper runs', async () => {
    // Between two sweeper runs there is a window in which an expired request still says pending.
    const { payments, merchant, payer } = await setup();

    const created = await request(payments, merchant.id, {
      expiresAt: new Date(clock.getTime() + 60_000),
    });

    clock = new Date(clock.getTime() + 120_000);

    await expect(
      payments.pay({ id: created.id, organizationId: 'org_a', payerWalletId: payer.id }),
    ).rejects.toThrow(/the amount may no longer be right/);
  });

  it('refuses to pay a cancelled request', async () => {
    const { payments, merchant, payer } = await setup();
    const created = await request(payments, merchant.id);

    await payments.cancel({ id: created.id, organizationId: 'org_a', reason: 'Order withdrawn.' });

    await expect(
      payments.pay({ id: created.id, organizationId: 'org_a', payerWalletId: payer.id }),
    ).rejects.toThrow(/is cancelled and cannot be paid/);
  });

  it('refuses a partial payment unless the request accepts one', async () => {
    const { payments, merchant, payer } = await setup();
    const created = await request(payments, merchant.id);

    const error = await caught(() =>
      payments.pay({
        id: created.id,
        organizationId: 'org_a',
        payerWalletId: payer.id,
        amount: usd('40.00'),
      }),
    );

    expect(detailsOf(error)).toMatch(/does not accept partial payment/);
  });

  it('refuses to overpay', async () => {
    const { payments, merchant, payer } = await setup();
    const created = await request(payments, merchant.id);

    const error = await caught(() =>
      payments.pay({
        id: created.id,
        organizationId: 'org_a',
        payerWalletId: payer.id,
        amount: usd('150.00'),
      }),
    );

    expect(detailsOf(error)).toMatch(/Overpaying is a separate transaction/);
  });

  it('does not pay another tenant’s request', async () => {
    const { payments, merchant, payer } = await setup();
    const created = await request(payments, merchant.id);

    await expect(
      payments.pay({ id: created.id, organizationId: 'org_b', payerWalletId: payer.id }),
    ).rejects.toThrow(/No payment request with id/);
  });
});

describe('settling', () => {
  it('marks a request paid and records how much', async () => {
    const { payments, merchant } = await setup();
    const created = await request(payments, merchant.id);

    const settled = await payments.settle({
      id: created.id,
      organizationId: 'org_a',
      amount: usd('100.00'),
      providerReference: 'prov_abc',
    });

    expect(settled.status).toBe('paid');
    expect(settled.paidAt).toEqual(clock);
    expect(settled.providerReference).toBe('prov_abc');
  });

  it('tracks a partial settlement and the outstanding balance', async () => {
    const { payments, merchant } = await setup();
    const created = await request(payments, merchant.id, { allowPartial: true });

    const partial = await payments.settle({
      id: created.id,
      organizationId: 'org_a',
      amount: usd('40.00'),
    });

    expect(partial.status).toBe('partially_paid');
    expect(formatMoney(payments.outstandingOf(partial))).toBe('60.00 USD');

    const full = await payments.settle({
      id: created.id,
      organizationId: 'org_a',
      amount: usd('60.00'),
    });

    expect(full.status).toBe('paid');
    expect(formatMoney(payments.outstandingOf(full))).toBe('0.00 USD');
  });

  it('is separate from paying, because payment is not always synchronous', async () => {
    // `pay` raises the transaction; `settle` is called when it completes.
    const { payments, merchant, payer } = await setup();
    const created = await request(payments, merchant.id);

    const { request: afterPay } = await payments.pay({
      id: created.id,
      organizationId: 'org_a',
      payerWalletId: payer.id,
    });

    expect(afterPay.status).toBe('processing');
    expect(afterPay.paidAt).toBeNull();
  });
});

describe('expiry', () => {
  it('expires unpaid requests on a sweep', async () => {
    const { payments, merchant } = await setup();

    await request(payments, merchant.id, { expiresAt: new Date(clock.getTime() + 60_000) });

    clock = new Date(clock.getTime() + 120_000);

    expect((await payments.expireStale({ organizationId: 'org_a' })).expired).toBe(1);
  });

  it('leaves a paid request alone', async () => {
    const { payments, merchant } = await setup();

    const created = await request(payments, merchant.id, {
      expiresAt: new Date(clock.getTime() + 60_000),
    });
    await payments.settle({ id: created.id, organizationId: 'org_a', amount: usd('100.00') });

    clock = new Date(clock.getTime() + 120_000);

    expect((await payments.expireStale({ organizationId: 'org_a' })).expired).toBe(0);
  });
});

describe('callbacks', () => {
  it('notifies on a status change', async () => {
    const onStatusChange = vi.fn(async () => {});
    const { payments, merchant } = await setup({ onStatusChange });

    const created = await request(payments, merchant.id);
    await payments.settle({ id: created.id, organizationId: 'org_a', amount: usd('100.00') });

    expect(onStatusChange).toHaveBeenCalledOnce();
    expect(onStatusChange.mock.calls[0]![1]).toBe('pending');
  });

  it('does not undo a payment because a callback failed', async () => {
    /*
     * The money moved. Failing here would leave the caller believing it did not, and the retry
     * would be a second payment.
     */
    const onStatusChange = vi.fn(async () => {
      throw new Error('The subscriber is down.');
    });

    const { payments, merchant } = await setup({ onStatusChange });
    const created = await request(payments, merchant.id);

    await expect(
      payments.settle({ id: created.id, organizationId: 'org_a', amount: usd('100.00') }),
    ).resolves.toMatchObject({ status: 'paid' });
  });
});

describe('the schema', () => {
  it('requires an expiry', () => {
    const result = paymentRequestSchema.safeParse({
      id: 'pay_1',
      organizationId: 'org_a',
      reference: 'PAY-ABCD',
      amount: { currency: 'USD', amount: '100.00' },
      payeeAccountId: 'acc_1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(result.success).toBe(false);
  });
});

describe('audit', () => {
  it('records creation with the reference and the amount', async () => {
    const { payments, audit, merchant } = await setup();
    await request(payments, merchant.id);

    expect(audit.record.mock.calls[0]![0]).toMatchObject({
      action: 'transactions.request.created',
      actorId: 'usr_merchant',
      after: expect.objectContaining({ amount: '100.00 USD', invoiceReference: 'INV-2001' }),
    });
  });
});
