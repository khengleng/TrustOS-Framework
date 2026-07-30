import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@trustos/errors';
import { CurrencyRegistry, formatMoney, money } from '@trustos/financial-core';
import { AccountService, InMemoryAccountStore } from '@trustos/accounts';
import { InMemoryLedgerStore, Ledger, credit, debit } from '@trustos/ledger';
import {
  ReportExporter,
  ReportingService,
  csvRenderer,
  generalLedgerRows,
  toCsv,
  toStatement,
  trialBalanceRows,
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
