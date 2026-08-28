import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@trustos/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { AccountService, InMemoryAccountStore } from '@trustos/accounts';
import { InMemoryLedgerStore, Ledger, credit, debit } from '@trustos/ledger';
import {
  ReportExporter,
  ReportingService,
  csvRenderer,
  exceptionReport,
  exceptionReportRows,
  feeReport,
  feeReportRows,
  generalLedgerRows,
  toCsv,
  toStatement,
  transactionReport,
  transactionReportRows,
  trialBalanceRows,
  walletReport,
  walletReportRows,
} from './reports';

/**
 * Two things here are worth a test rather than a read.
 *
 * The running balance, which is what turns "the balance is out by 12.50" into "it was right until
 * this line". And the CSV escaping, because a financial export is the one file guaranteed to be
 * opened in a spreadsheet.
 */

const currencies = new CurrencyRegistry();
const usd = (amount: string) => money(amount, 'USD', currencies);

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function detailsOf(error: unknown): string {
  const details = (error as { details?: Array<{ message: string }> }).details ?? [];
  return details.map((detail) => detail.message).join(' | ');
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

  const reporting = new ReportingService({ ledger, accounts, currencies, now: () => clock });

  const bank = await accounts.open({
    organizationId: 'org_a',
    code: 'system.bank.usd',
    name: 'Operating bank',
    type: 'system',
    currency: 'USD',
  });

  const customer = await accounts.open({
    organizationId: 'org_a',
    code: 'customer.usr_1.usd',
    name: 'Dara',
    type: 'customer',
    currency: 'USD',
  });

  const revenue = await accounts.open({
    organizationId: 'org_a',
    code: 'fee.processing.usd',
    name: 'Processing fees',
    type: 'fee',
    currency: 'USD',
  });

  return { ledger, accounts, reporting, bank, customer, revenue };
}

const period = {
  from: new Date('2026-02-01T00:00:00.000Z'),
  to: new Date('2026-03-31T23:59:59.000Z'),
};

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('the general ledger', () => {
  it('shows a running balance that turns a discrepancy into a line', async () => {
    const { ledger, reporting, bank, customer } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      reference: 'DEP-1',
      effectiveAt: new Date('2026-03-01T10:00:00.000Z'),
      entries: [debit(bank.id, usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    await ledger.post({
      organizationId: 'org_a',
      description: 'Payment',
      reference: 'PAY-1',
      effectiveAt: new Date('2026-03-02T10:00:00.000Z'),
      entries: [debit(customer.id, usd('30.00')), credit(bank.id, usd('30.00'))],
    });

    const report = await reporting.generalLedger({
      organizationId: 'org_a',
      accountId: customer.id,
      period,
    });

    expect(report.lines.map((line) => formatMoney(line.runningBalance))).toEqual([
      '100.00 USD',
      '70.00 USD',
    ]);
    expect(formatMoney(report.closingBalance)).toBe('70.00 USD');
    expect(formatMoney(report.totalDebits)).toBe('30.00 USD');
    expect(formatMoney(report.totalCredits)).toBe('100.00 USD');
  });

  it('starts from the opening balance, not from zero', async () => {
    /*
     * Without it the running balance starts at zero and disagrees with every other report — which
     * is the version that sends somebody looking for a missing 100.
     */
    const { ledger, reporting, bank, customer } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Earlier deposit',
      effectiveAt: new Date('2026-01-15T00:00:00.000Z'),
      entries: [debit(bank.id, usd('500.00')), credit(customer.id, usd('500.00'))],
    });

    await ledger.post({
      organizationId: 'org_a',
      description: 'In-period payment',
      effectiveAt: new Date('2026-03-01T10:00:00.000Z'),
      entries: [debit(customer.id, usd('50.00')), credit(bank.id, usd('50.00'))],
    });

    const report = await reporting.generalLedger({
      organizationId: 'org_a',
      accountId: customer.id,
      period,
    });

    expect(formatMoney(report.openingBalance)).toBe('500.00 USD');
    expect(formatMoney(report.closingBalance)).toBe('450.00 USD');
    expect(report.lines).toHaveLength(1);
  });

  it('states when it was taken', async () => {
    // A balance that cannot be reproduced settles no argument.
    const { reporting, customer } = await setup();

    const report = await reporting.generalLedger({
      organizationId: 'org_a',
      accountId: customer.id,
      period,
    });

    expect(report.generatedAt).toEqual(clock);
  });
});

describe('the trial balance', () => {
  it('reports every account in its own terms', async () => {
    const { ledger, reporting, bank, customer } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      entries: [debit(bank.id, usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    const report = await reporting.trialBalance({ organizationId: 'org_a' });

    const customerLine = report.lines.find((line) => line.accountCode === 'customer.usr_1.usd')!;
    const bankLine = report.lines.find((line) => line.accountCode === 'system.bank.usd')!;

    // Both read as "there is this much in it", whatever the class.
    expect(formatMoney(customerLine.balance)).toBe('100.00 USD');
    expect(formatMoney(bankLine.balance)).toBe('100.00 USD');
    expect(report.balanced).toBe(true);
  });

  it('names an account it does not recognise rather than guessing a sign', async () => {
    const { ledger, reporting, bank } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Posting to an account with no record',
      entries: [debit(bank.id, usd('10.00')), credit('acc_unknown', usd('10.00'))],
    });

    const report = await reporting.trialBalance({ organizationId: 'org_a' });
    const unknown = report.lines.find((line) => line.accountId === 'acc_unknown')!;

    expect(unknown.accountName).toBe('(unknown account)');
    expect(unknown.accountClass).toBe('unknown');
  });

  it('reports as of a moment, so a closed period does not move', async () => {
    const { ledger, reporting, bank, customer } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'January',
      effectiveAt: new Date('2026-01-15T00:00:00.000Z'),
      entries: [debit(bank.id, usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    await ledger.post({
      organizationId: 'org_a',
      description: 'February',
      effectiveAt: new Date('2026-02-15T00:00:00.000Z'),
      entries: [debit(bank.id, usd('50.00')), credit(customer.id, usd('50.00'))],
    });

    const january = await reporting.trialBalance({
      organizationId: 'org_a',
      asOf: new Date('2026-01-31T23:59:59.000Z'),
    });

    expect(formatMoney(january.totals[0]!.debits)).toBe('100.00 USD');
  });
});

describe('the balance sheet', () => {
  it('checks the accounting equation', async () => {
    const { ledger, reporting, bank, customer, revenue } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      entries: [debit(bank.id, usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    await ledger.post({
      organizationId: 'org_a',
      description: 'Fee charged',
      entries: [debit(customer.id, usd('2.50')), credit(revenue.id, usd('2.50'))],
    });

    const sheet = await reporting.balanceSheet({ organizationId: 'org_a', currency: 'USD' });

    expect(formatMoney(sheet.assets)).toBe('100.00 USD');
    expect(formatMoney(sheet.liabilities)).toBe('97.50 USD');
    expect(formatMoney(sheet.revenue)).toBe('2.50 USD');
    expect(sheet.balanced).toBe(true);
  });
});

describe('statements', () => {
  it('signs amounts from the holder’s point of view, not the accountant’s', async () => {
    /*
     * A customer reading "debit 50.00" on their own statement reads it as money arriving, because
     * that is what a bank statement means to them. The accounting sense is the opposite.
     */
    const { ledger, reporting, bank, customer } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      entries: [debit(bank.id, usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    await ledger.post({
      organizationId: 'org_a',
      description: 'Payment out',
      effectiveAt: new Date('2026-03-02T00:00:00.000Z'),
      entries: [debit(customer.id, usd('30.00')), credit(bank.id, usd('30.00'))],
    });

    const report = await reporting.generalLedger({
      organizationId: 'org_a',
      accountId: customer.id,
      period,
    });

    const statement = toStatement(report, 'liability');

    expect(formatMoney(statement[0]!.amount)).toBe('100.00 USD');
    expect(formatMoney(statement[1]!.amount)).toBe('-30.00 USD');
  });
});

describe('CSV', () => {
  it('neutralises a formula before a spreadsheet executes it', () => {
    /*
     * A value beginning `=`, `+`, `-` or `@` is a formula that runs when the file is opened, and
     * the value came from a user. A financial export is the one file guaranteed to be opened in a
     * spreadsheet.
     */
    const csv = toCsv([
      { description: '=1+1', reference: '@SUM(A1:A9)', amount: '10.00' },
      { description: '-2+3', reference: '+cmd', amount: '20.00' },
    ]);

    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@SUM(A1:A9)");
    expect(csv).toContain("'-2+3");
    expect(csv).toContain("'+cmd");
  });

  it('quotes a cell containing a comma or a newline', () => {
    const csv = toCsv([{ description: 'Payment, refunded', reference: 'a\nb' }]);

    expect(csv).toContain('"Payment, refunded"');
    expect(csv).toContain('"a\nb"');
  });

  it('doubles an embedded quote', () => {
    expect(toCsv([{ description: 'He said "hello"' }])).toContain('"He said ""hello"""');
  });

  it('returns nothing for no rows, rather than a lone header', () => {
    expect(toCsv([])).toBe('');
  });

  it('renders a trial balance', async () => {
    const { ledger, reporting, bank, customer } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      entries: [debit(bank.id, usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    const report = await reporting.trialBalance({ organizationId: 'org_a' });
    const csv = toCsv(trialBalanceRows(report));

    expect(csv.split('\n')[0]).toBe(
      'account_code,account_name,class,currency,debits,credits,balance',
    );
    expect(csv).toContain('customer.usr_1.usd,Dara,liability,USD,0.00,100.00,100.00');
  });

  it('renders a general ledger with separate debit and credit columns', async () => {
    const { ledger, reporting, bank, customer } = await setup();

    await ledger.post({
      organizationId: 'org_a',
      description: 'Deposit',
      reference: 'DEP-1',
      entries: [debit(bank.id, usd('100.00')), credit(customer.id, usd('100.00'))],
    });

    const report = await reporting.generalLedger({
      organizationId: 'org_a',
      accountId: customer.id,
      period,
    });

    const rows = generalLedgerRows(report);

    expect(rows[0]).toMatchObject({ debit: '', credit: '100.00', balance: '100.00' });
  });
});

describe('the renderer seam', () => {
  it('ships CSV and says so when asked for anything else', async () => {
    /*
     * An auditor who asked for a PDF and received a CSV will ask why, and "it fell back" is not an
     * answer.
     */
    const exporter = new ReportExporter();

    expect(exporter.formats()).toEqual(['csv']);

    try {
      await exporter.render({ format: 'pdf', title: 'Trial balance', rows: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(detailsOf(error)).toMatch(/framework ships CSV only/);
      expect(detailsOf(error)).toMatch(/Available: csv/);
    }
  });

  it('takes a registered renderer for another format', async () => {
    const exporter = new ReportExporter([csvRenderer]);

    exporter.register({
      format: 'xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      render: async () => new Uint8Array([1, 2, 3]),
    });

    const result = await exporter.render({ format: 'xlsx', title: 'x', rows: [] });

    expect(result.contentType).toMatch(/spreadsheetml/);
    expect(exporter.formats()).toEqual(['csv', 'xlsx']);
  });
});

describe('the wallet report', () => {
  const line = (
    ownerId: string,
    total: string,
    held = '0.00',
    reserved = '0.00',
    currency = 'USD',
  ) => ({
    walletId: `wlt_${ownerId}`,
    ownerId,
    currency,
    status: 'active',
    total: money(total, currency, currencies),
    held: money(held, currency, currencies),
    reserved: money(reserved, currency, currencies),
    available: money(
      (Number(total) - Number(held) - Number(reserved)).toFixed(2),
      currency,
      currencies,
    ),
  });

  it('totals per currency, because a total across currencies means nothing', () => {
    const report = walletReport({
      organizationId: 'org_a',
      asOf: clock,
      generatedAt: clock,
      currencies,
      lines: [
        line('usr_1', '100.00'),
        line('usr_2', '250.00'),
        { ...line('usr_3', '400000', '0', '0', 'KHR') },
      ],
    });

    expect(report.totals).toHaveLength(2);
    expect(formatMoney(report.totals.find((total) => total.currency === 'USD')!.total)).toBe(
      '350.00 USD',
    );
    expect(formatMoney(report.totals.find((total) => total.currency === 'KHR')!.total)).toBe(
      '400000 KHR',
    );
  });

  it('separates held from reserved in the totals', async () => {
    const report = walletReport({
      organizationId: 'org_a',
      asOf: clock,
      generatedAt: clock,
      currencies,
      lines: [line('usr_1', '1000.00', '300.00', '200.00')],
    });

    const usdTotal = report.totals[0]!;

    expect(formatMoney(usdTotal.held)).toBe('300.00 USD');
    expect(formatMoney(usdTotal.reserved)).toBe('200.00 USD');
    expect(formatMoney(usdTotal.available)).toBe('500.00 USD');
  });

  it('renders as CSV with every balance', () => {
    const report = walletReport({
      organizationId: 'org_a',
      asOf: clock,
      generatedAt: clock,
      currencies,
      lines: [line('usr_1', '1000.00', '300.00', '200.00')],
    });

    const csv = toCsv(walletReportRows(report));

    expect(csv.split('\n')[0]).toBe(
      'wallet_id,owner_id,currency,status,total,held,reserved,available',
    );
    expect(csv).toContain('wlt_usr_1,usr_1,USD,active,1000.00,300.00,200.00,500.00');
  });
});

describe('the transaction report', () => {
  const line = (
    id: string,
    status: string,
    amount: string,
    type = 'payment',
    fee: string | null = null,
  ) => ({
    transactionId: id,
    at: clock,
    type,
    status,
    currency: 'USD',
    amount: usd(amount),
    feeAmount: fee ? usd(fee) : null,
    reference: `ORD-${id}`,
    failureCode: status === 'failed' ? 'provider_declined' : null,
  });

  const report = () =>
    transactionReport({
      organizationId: 'org_a',
      period,
      currency: 'USD',
      generatedAt: clock,
      currencies,
      lines: [
        line('1', 'completed', '100.00', 'payment', '2.50'),
        line('2', 'completed', '200.00', 'payment', '5.00'),
        line('3', 'failed', '50.00'),
        line('4', 'completed', '75.00', 'refund'),
      ],
    });

  it('groups by status and by type, because they answer different questions', () => {
    // "How much did we process" and "what is failing".
    const result = report();

    expect(result.byStatus.find((entry) => entry.status === 'completed')!.count).toBe(3);
    expect(formatMoney(result.byStatus.find((entry) => entry.status === 'failed')!.value)).toBe(
      '50.00 USD',
    );
    expect(result.byType.find((entry) => entry.type === 'refund')!.count).toBe(1);
  });

  it('computes the success rate over everything attempted', () => {
    // A rate computed over successes only is always 100%.
    expect(report().successRate).toBe(0.75);
  });

  it('reports zero rather than dividing by nothing for an empty period', () => {
    const empty = transactionReport({
      organizationId: 'org_a',
      period,
      currency: 'USD',
      generatedAt: clock,
      currencies,
      lines: [],
    });

    expect(empty.successRate).toBe(0);
    expect(formatMoney(empty.totalValue)).toBe('0.00 USD');
  });

  it('totals the fees separately from the value', () => {
    const result = report();

    expect(formatMoney(result.totalValue)).toBe('425.00 USD');
    expect(formatMoney(result.totalFees)).toBe('7.50 USD');
  });

  it('renders as CSV with the failure code', () => {
    const csv = toCsv(transactionReportRows(report()));

    expect(csv).toContain('provider_declined');
  });
});

describe('the fee report', () => {
  const result = () =>
    feeReport({
      organizationId: 'org_a',
      period,
      currency: 'USD',
      generatedAt: clock,
      currencies,
      transactionValue: usd('10000.00'),
      lines: [
        {
          scheduleKey: 'payment.standard',
          scheduleVersion: 1,
          componentName: 'Processing',
          revenueAccountCode: 'fee.processing.usd',
          currency: 'USD',
          count: 40,
          amount: usd('100.00'),
        },
        {
          scheduleKey: 'payment.standard',
          scheduleVersion: 2,
          componentName: 'Processing',
          revenueAccountCode: 'fee.processing.usd',
          currency: 'USD',
          count: 60,
          amount: usd('150.00'),
        },
      ],
    });

  it('keeps the versions apart', () => {
    /*
     * A schedule that changed mid-period produces two versions in one report, and collapsing them
     * hides exactly the thing somebody is looking for when they ask why revenue moved.
     */
    expect(result().lines.map((line) => line.scheduleVersion)).toEqual([1, 2]);
  });

  it('reports the effective rate in basis points', () => {
    // 250.00 on 10,000.00 is 250 basis points.
    expect(result().effectiveRate).toBe('250.00');
  });

  it('reports a zero rate for a period with no volume, rather than dividing by zero', () => {
    const empty = feeReport({
      organizationId: 'org_a',
      period,
      currency: 'USD',
      generatedAt: clock,
      currencies,
      transactionValue: usd('0.00'),
      lines: [],
    });

    expect(empty.effectiveRate).toBe('0');
  });

  it('renders as CSV with the revenue account', () => {
    expect(toCsv(feeReportRows(result()))).toContain('fee.processing.usd');
  });
});

describe('the exception report', () => {
  const line = (
    id: string,
    source: 'reconciliation' | 'settlement' | 'suspense',
    ageDays: number,
  ) => ({
    source,
    id,
    kind: 'missing_internal',
    reference: `REF-${id}`,
    detail: 'Money on the statement with nothing matching it internally.',
    amount: usd('250.00'),
    openedAt: new Date(clock.getTime() - ageDays * 86_400_000),
    ageMs: ageDays * 86_400_000,
    assignedTo: ageDays > 30 ? null : 'usr_ops',
  });

  const result = () =>
    exceptionReport({
      organizationId: 'org_a',
      asOf: clock,
      generatedAt: clock,
      lines: [
        line('a', 'reconciliation', 2),
        line('b', 'settlement', 45),
        line('c', 'suspense', 10),
      ],
    });

  it('sorts oldest first, deliberately', () => {
    /*
     * Newest-first buries the item nobody wants to pick up, which is reliably the one that
     * matters.
     */
    expect(result().lines.map((line) => line.id)).toEqual(['b', 'c', 'a']);
  });

  it('reports the oldest age, which says whether the queue is being worked', () => {
    expect(result().oldestAgeMs).toBe(45 * 86_400_000);
  });

  it('counts what nobody owns', () => {
    expect(result().unassigned).toBe(1);
  });

  it('brings every source into one report', () => {
    // The question is "what is broken", and spreading the answer across three screens is how a
    // six-week-old item survives.
    expect(result().bySource.map((entry) => entry.source)).toEqual([
      'reconciliation',
      'settlement',
      'suspense',
    ]);
  });

  it('renders as CSV with the age in days', () => {
    const csv = toCsv(exceptionReportRows(result()));

    expect(csv.split('\n')[1]).toContain(',45,');
  });

  it('reports no oldest age for an empty queue, rather than zero', () => {
    // Zero would read as "the oldest item is brand new", which is the opposite of empty.
    const empty = exceptionReport({
      organizationId: 'org_a',
      asOf: clock,
      generatedAt: clock,
      lines: [],
    });

    expect(empty.oldestAgeMs).toBeNull();
  });
});
