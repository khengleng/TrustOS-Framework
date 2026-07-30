import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { AccountService, InMemoryAccountStore } from '@trustos/accounts';
import { InMemoryLedgerStore, Ledger, credit, debit } from '@trustos/ledger';
import { SettlementService } from './settlement';
import { InMemorySettlementStore } from './testing';

/**
 * The tests that matter are about the settlement account.
 *
 * A system that debits the merchant and credits the bank directly cannot represent Friday-to-Monday
 * and has no number to reconcile. Every test below that checks the in-transit balance is really
 * testing that the intermediate account exists and behaves.
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

async function setup() {
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

  const audit = { record: vi.fn() };

  const settlement = new SettlementService({
    store: new InMemorySettlementStore(),
    ledger,
    accounts,
    currencies,
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  const settlementAccount = await accounts.open({
    organizationId: 'org_a',
    code: 'settlement.bank.usd',
    name: 'Settlement in transit',
    type: 'settlement',
    currency: 'USD',
  });

  const bank = await accounts.open({
    organizationId: 'org_a',
    code: 'system.bank.usd',
    name: 'Operating bank',
    type: 'system',
    currency: 'USD',
  });

  const merchantA = await accounts.open({
    organizationId: 'org_a',
    code: 'merchant.mer_a.usd',
    name: 'Merchant A',
    type: 'merchant',
    currency: 'USD',
  });

  const merchantB = await accounts.open({
    organizationId: 'org_a',
    code: 'merchant.mer_b.usd',
    name: 'Merchant B',
    type: 'merchant',
    currency: 'USD',
  });

  // Fund the merchants: they have earned money that is owed to them.
  await ledger.post({
    organizationId: 'org_a',
    description: 'Merchant earnings',
    entries: [
      debit(bank.id, usd('1000.00')),
      credit(merchantA.id, usd('600.00')),
      credit(merchantB.id, usd('400.00')),
    ],
  });

  return { settlement, ledger, accounts, audit, settlementAccount, bank, merchantA, merchantB };
}

const openBatch = (
  settlement: SettlementService,
  settlementAccountId: string,
  overrides: Record<string, unknown> = {},
) =>
  settlement.openBatch({
    organizationId: 'org_a',
    currency: 'USD',
    windowStart: new Date('2026-02-28T00:00:00.000Z'),
    windowEnd: new Date('2026-03-01T00:00:00.000Z'),
    settlementAccountId,
    actorId: 'usr_ops',
    ...overrides,
  });

async function batchWithInstructions(context: Awaited<ReturnType<typeof setup>>) {
  const batch = await openBatch(context.settlement, context.settlementAccount.id);

  await context.settlement.addInstruction({
    batchId: batch.id,
    organizationId: 'org_a',
    counterpartyId: 'mer_a',
    counterpartyName: 'Merchant A',
    sourceAccountId: context.merchantA.id,
    amount: usd('600.00'),
    transactionIds: ['txn_1', 'txn_2'],
  });

  const { batch: withBoth, instruction: second } = await context.settlement.addInstruction({
    batchId: batch.id,
    organizationId: 'org_a',
    counterpartyId: 'mer_b',
    counterpartyName: 'Merchant B',
    sourceAccountId: context.merchantB.id,
    amount: usd('400.00'),
    transactionIds: ['txn_3'],
  });

  return { batch: withBoth, secondInstruction: second };
}

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('batches', () => {
  it('names itself after the window it covers', async () => {
    const { settlement, settlementAccount } = await setup();
    const batch = await openBatch(settlement, settlementAccount.id);

    expect(batch.reference).toBe('SETTLE-2026-03-01-USD');
    expect(batch.status).toBe('open');
  });

  it('refuses a window that ends before it starts', async () => {
    const { settlement, settlementAccount } = await setup();

    const error = await caught(() =>
      openBatch(settlement, settlementAccount.id, {
        windowStart: new Date('2026-03-01T00:00:00.000Z'),
        windowEnd: new Date('2026-02-28T00:00:00.000Z'),
      }),
    );

    expect(detailsOf(error)).toMatch(/must end after it starts/);
  });

  it('keeps a running total as instructions are added', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    expect(batch.instructionCount).toBe(2);
    expect(`${batch.totalAmount.amount} ${batch.totalAmount.currency}`).toBe('1000.00 USD');
  });

  it('refuses an instruction in another currency', async () => {
    // A mixed batch has a total that means nothing.
    const context = await setup();
    const batch = await openBatch(context.settlement, context.settlementAccount.id);

    const error = await caught(() =>
      context.settlement.addInstruction({
        batchId: batch.id,
        organizationId: 'org_a',
        counterpartyId: 'mer_a',
        sourceAccountId: context.merchantA.id,
        amount: money('400000', 'KHR', currencies),
      }),
    );

    expect(detailsOf(error)).toMatch(/One batch, one currency/);
  });

  it('refuses to close an empty batch', async () => {
    /*
     * An empty file to a counterparty is at best noise and at worst a signal that something
     * upstream failed — and the batch still appears on the report as if it did something.
     */
    const { settlement, settlementAccount } = await setup();
    const batch = await openBatch(settlement, settlementAccount.id);

    await expect(settlement.closeBatch({ id: batch.id, organizationId: 'org_a' })).rejects.toThrow(
      /hides whatever failed upstream/,
    );
  });

  it('refuses an instruction after the batch is closed', async () => {
    // The counterparty would receive a file that no longer matches what we think we sent.
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });

    await expect(
      context.settlement.addInstruction({
        batchId: batch.id,
        organizationId: 'org_a',
        counterpartyId: 'mer_c',
        sourceAccountId: context.merchantA.id,
        amount: usd('10.00'),
      }),
    ).rejects.toThrow(/no more instructions can be added/);
  });
});

describe('the settlement account', () => {
  it('holds the money between sending and confirmation', async () => {
    /*
     * The whole mechanism. Between Friday and Monday the money has left the merchant and not
     * arrived at the bank, and the settlement account balance is exactly that.
     */
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });

    const inTransit = await context.settlement.inTransit({
      organizationId: 'org_a',
      settlementAccountId: context.settlementAccount.id,
    });

    expect(formatMoney(inTransit.amount)).toBe('1000.00 USD');
    expect(inTransit.batches).toHaveLength(1);

    // The merchants have been debited.
    expect(
      formatMoney(
        await context.accounts.balance(await context.accounts.get(context.merchantA.id, 'org_a')),
      ),
    ).toBe('0.00 USD');
  });

  it('empties when the counterparty confirms', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });

    await context.settlement.confirmBatch({
      id: batch.id,
      organizationId: 'org_a',
      destinationAccountId: context.bank.id,
      externalReference: 'BANKREF-99',
    });

    const inTransit = await context.settlement.inTransit({
      organizationId: 'org_a',
      settlementAccountId: context.settlementAccount.id,
    });

    expect(formatMoney(inTransit.amount)).toBe('0.00 USD');
  });

  it('keeps the ledger balanced through the whole cycle', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.confirmBatch({
      id: batch.id,
      organizationId: 'org_a',
      destinationAccountId: context.bank.id,
    });

    const trial = await context.ledger.trialBalance({ organizationId: 'org_a' });

    expect(trial.balanced).toBe(true);
  });
});

describe('partial confirmation', () => {
  it('returns a rejected instruction to the merchant it came from', async () => {
    /*
     * Per instruction, not as a lump sum. A lump sum landing somewhere for somebody to allocate is
     * how a merchant's balance ends up wrong for a week.
     */
    const context = await setup();
    const { batch, secondInstruction } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });

    const result = await context.settlement.confirmBatch({
      id: batch.id,
      organizationId: 'org_a',
      destinationAccountId: context.bank.id,
      returned: [{ instructionId: secondInstruction.id, reason: 'Account closed at the bank.' }],
    });

    expect(formatMoney(result.returnedAmount)).toBe('400.00 USD');

    // Merchant B has their money back; Merchant A's has settled.
    expect(
      formatMoney(
        await context.accounts.balance(await context.accounts.get(context.merchantB.id, 'org_a')),
      ),
    ).toBe('400.00 USD');
    expect(
      formatMoney(
        await context.accounts.balance(await context.accounts.get(context.merchantA.id, 'org_a')),
      ),
    ).toBe('0.00 USD');

    const inTransit = await context.settlement.inTransit({
      organizationId: 'org_a',
      settlementAccountId: context.settlementAccount.id,
    });

    expect(formatMoney(inTransit.amount)).toBe('0.00 USD');
  });

  it('records why each instruction was returned', async () => {
    const context = await setup();
    const { batch, secondInstruction } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.confirmBatch({
      id: batch.id,
      organizationId: 'org_a',
      destinationAccountId: context.bank.id,
      returned: [{ instructionId: secondInstruction.id, reason: 'Account closed at the bank.' }],
    });

    const instructions = await context.settlement.instructions(batch.id, 'org_a');
    const returned = instructions.find((instruction) => instruction.id === secondInstruction.id)!;

    expect(returned.status).toBe('returned');
    expect(returned.failureReason).toBe('Account closed at the bank.');
  });
});

describe('failure', () => {
  it('reverses the send, putting every merchant back where they were', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });

    await context.settlement.failBatch({
      id: batch.id,
      organizationId: 'org_a',
      reason: 'The bank rejected the file.',
    });

    expect(
      formatMoney(
        await context.accounts.balance(await context.accounts.get(context.merchantA.id, 'org_a')),
      ),
    ).toBe('600.00 USD');
    expect(
      formatMoney(
        await context.accounts.balance(await context.accounts.get(context.merchantB.id, 'org_a')),
      ),
    ).toBe('400.00 USD');

    const trial = await context.ledger.trialBalance({ organizationId: 'org_a' });
    expect(trial.balanced).toBe(true);
  });
});

describe('the state machine', () => {
  it('refuses to send a batch that was never closed', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await expect(
      context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' }),
    ).rejects.toThrow(/is open and cannot become sent/);
  });

  it('refuses to confirm a batch that was never sent', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });

    await expect(
      context.settlement.confirmBatch({
        id: batch.id,
        organizationId: 'org_a',
        destinationAccountId: context.bank.id,
      }),
    ).rejects.toThrow(/is pending and cannot become settled/);
  });

  it('makes a settled batch final', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.confirmBatch({
      id: batch.id,
      organizationId: 'org_a',
      destinationAccountId: context.bank.id,
    });

    await expect(
      context.settlement.failBatch({
        id: batch.id,
        organizationId: 'org_a',
        reason: 'Too late.',
      }),
    ).rejects.toThrow(/a correction is a new batch/);
  });
});

describe('idempotency', () => {
  it('does not double-post a retried send', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    const first = await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });

    // The state machine refuses the second attempt, and the ledger's idempotency key would have
    // caught it too.
    await expect(
      context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' }),
    ).rejects.toThrow();

    const journals = await context.ledger.list({ organizationId: 'org_a' });

    expect(journals.filter((journal) => journal.id === first.journal.id)).toHaveLength(1);
  });
});

describe('the report', () => {
  it('says what became of every instruction', async () => {
    const context = await setup();
    const { batch, secondInstruction } = await batchWithInstructions(context);

    await context.settlement.closeBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.sendBatch({ id: batch.id, organizationId: 'org_a' });
    await context.settlement.confirmBatch({
      id: batch.id,
      organizationId: 'org_a',
      destinationAccountId: context.bank.id,
      returned: [{ instructionId: secondInstruction.id, reason: 'Account closed.' }],
    });

    const report = await context.settlement.report({ id: batch.id, organizationId: 'org_a' });

    expect(report.instructionCount).toBe(2);
    expect(formatMoney(report.total)).toBe('1000.00 USD');
    expect(formatMoney(report.settled)).toBe('600.00 USD');
    expect(formatMoney(report.returned)).toBe('400.00 USD');
    expect(report.counterparties).toBe(2);
  });

  it('keeps the transaction ids, so a batch is explicable afterwards', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    const report = await context.settlement.report({ id: batch.id, organizationId: 'org_a' });

    expect(report.instructions[0]!.transactionIds).toEqual(['txn_1', 'txn_2']);
  });
});

describe('tenancy', () => {
  it('does not let one tenant send another’s batch', async () => {
    const context = await setup();
    const { batch } = await batchWithInstructions(context);

    await expect(
      context.settlement.closeBatch({ id: batch.id, organizationId: 'org_b' }),
    ).rejects.toThrow(/No settlement batch with id/);
  });
});
