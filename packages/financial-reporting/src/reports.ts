import { ApiError } from '@trustos/errors';
import type { LoggerPort } from '@trustos/logging';
import {
  addMoney,
  formatDecimal,
  formatMoney,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';
import { NORMAL_SIDE, normalBalance, type Account, type AccountService } from '@trustos/accounts';
import type { Ledger } from '@trustos/ledger';

/**
 * Financial reports.
 *
 * The general ledger, the trial balance, and the statements somebody actually asks for.
 *
 * **Every report states the moment it was taken.** A balance without an `asOf` is a balance that
 * cannot be reproduced, and the first thing anybody does with a report they disagree with is run
 * it again — which produces a different number and settles nothing.
 *
 * **Reports read; they never post.** There is no method here that changes anything. That sounds
 * obvious and is the rule most often broken by a "reconcile and fix" report, which is two
 * operations wearing one name.
 */

export interface ReportPeriod {
  from: Date;
  to: Date;
}

export interface GeneralLedgerLine {
  journalId: string;
  effectiveAt: Date;
  reference: string | null;
  description: string;
  accountId: string;
  accountCode: string;
  direction: 'debit' | 'credit';
  amount: Money;
  /** The account's balance after this line, in the account's own terms. */
  runningBalance: Money;
}

export interface GeneralLedgerReport {
  organizationId: string | null;
  accountId: string;
  accountCode: string;
  currency: string;
  period: ReportPeriod;
  openingBalance: Money;
  closingBalance: Money;
  totalDebits: Money;
  totalCredits: Money;
  lines: GeneralLedgerLine[];
  generatedAt: Date;
}

export interface TrialBalanceLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountClass: string;
  currency: string;
  debits: Money;
  credits: Money;
  /** In the account's own terms: positive means "there is this much in it". */
  balance: Money;
}

export interface TrialBalanceReport {
  organizationId: string | null;
  asOf: Date;
  lines: TrialBalanceLine[];
  totals: Array<{ currency: string; debits: Money; credits: Money; difference: Money }>;
  balanced: boolean;
  problems: string[];
  generatedAt: Date;
}

export interface ReportingOptions {
  ledger: Ledger;
  accounts: AccountService;
  currencies?: CurrencyRegistry;
  logger?: LoggerPort;
  now?: () => Date;
}

export class ReportingService {
  private readonly now: () => Date;

  constructor(private readonly options: ReportingOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The general ledger for one account: every line, with a running balance.
   *
   * The report a bookkeeper asks for when a balance is wrong, and the running balance is why —
   * it turns "the balance is out by 12.50" into "it was right until this line".
   */
  async generalLedger(input: {
    organizationId: string | null;
    accountId: string;
    period: ReportPeriod;
    limit?: number;
  }): Promise<GeneralLedgerReport> {
    const account = await this.options.accounts.get(input.accountId, input.organizationId);
    const zero = zeroMoney(account.currency, this.options.currencies);

    // The opening balance is everything before the period. Without it the running balance starts
    // at zero and disagrees with every other report.
    const opening = await this.options.accounts.balance(account, input.period.from);

    const journals = await this.options.ledger.list({
      organizationId: input.organizationId,
      accountId: account.id,
      from: input.period.from,
      to: input.period.to,
      limit: input.limit ?? 10_000,
    });

    const lines: GeneralLedgerLine[] = [];
    let running = opening;
    let totalDebits = zero;
    let totalCredits = zero;

    for (const journal of journals) {
      for (const entry of journal.entries) {
        if (entry.accountId !== account.id) continue;
        if (entry.amount.currency !== account.currency) continue;

        const amount = this.moneyOf(entry.amount);

        if (entry.direction === 'debit') totalDebits = addMoney(totalDebits, amount);
        else totalCredits = addMoney(totalCredits, amount);

        // Toward the account's normal side is an increase; the other way is a decrease.
        const increases = NORMAL_SIDE[account.class] === entry.direction;
        running = increases ? addMoney(running, amount) : subtractMoney(running, amount);

        lines.push({
          journalId: journal.id,
          effectiveAt: journal.effectiveAt,
          reference: journal.reference,
          description: entry.description || journal.description,
          accountId: account.id,
          accountCode: account.code,
          direction: entry.direction,
          amount,
          runningBalance: running,
        });
      }
    }

    return {
      organizationId: input.organizationId,
      accountId: account.id,
      accountCode: account.code,
      currency: account.currency,
      period: input.period,
      openingBalance: opening,
      closingBalance: running,
      totalDebits,
      totalCredits,
      lines,
      generatedAt: this.now(),
    };
  }

  /**
   * The trial balance: every account with a balance, and whether the whole thing adds up.
   *
   * The single most useful integrity check in the system. Every journal balances at posting, so a
   * trial balance that does not balance means the data was changed outside the application.
   */
  async trialBalance(input: {
    organizationId: string | null;
    asOf?: Date;
    ledgerId?: string;
  }): Promise<TrialBalanceReport> {
    const asOf = input.asOf ?? this.now();

    const raw = await this.options.ledger.trialBalance({
      organizationId: input.organizationId,
      ledgerId: input.ledgerId,
      asOf,
    });

    const accounts = await this.options.accounts.list({
      organizationId: input.organizationId,
      limit: 5000,
    });

    const byId = new Map(accounts.map((account) => [account.id, account]));

    const lines: TrialBalanceLine[] = raw.accounts.map((entry) => {
      const account = byId.get(entry.accountId);

      return {
        accountId: entry.accountId,
        accountCode: account?.code ?? entry.accountId,
        accountName: account?.name ?? '(unknown account)',
        accountClass: account?.class ?? 'unknown',
        currency: entry.currency,
        debits: entry.debits,
        credits: entry.credits,
        // In the account's own terms, when the account is known. An unknown account keeps the raw
        // arithmetic rather than guessing at a sign.
        balance: account ? normalBalance(account, entry.balance) : entry.balance,
      };
    });

    return {
      organizationId: input.organizationId,
      asOf,
      lines: lines.sort(
        (a, b) =>
          a.accountCode.localeCompare(b.accountCode) || a.currency.localeCompare(b.currency),
      ),
      totals: raw.totals,
      balanced: raw.balanced,
      problems: raw.problems,
      generatedAt: this.now(),
    };
  }

  /**
   * Balances grouped by account class.
   *
   * The shape a balance sheet wants: assets, liabilities and equity, and whether the accounting
   * equation holds.
   */
  async balanceSheet(input: {
    organizationId: string | null;
    currency: string;
    asOf?: Date;
  }): Promise<{
    organizationId: string | null;
    currency: string;
    asOf: Date;
    assets: Money;
    liabilities: Money;
    equity: Money;
    revenue: Money;
    expenses: Money;
    /** assets − (liabilities + equity + revenue − expenses). Zero when the books are consistent. */
    difference: Money;
    balanced: boolean;
    generatedAt: Date;
  }> {
    const asOf = input.asOf ?? this.now();
    const trial = await this.trialBalance({ organizationId: input.organizationId, asOf });
    const zero = zeroMoney(input.currency, this.options.currencies);

    const of = (accountClass: string) =>
      trial.lines
        .filter((line) => line.currency === input.currency && line.accountClass === accountClass)
        .reduce<Money>((sum, line) => addMoney(sum, line.balance), zero);

    const assets = of('asset');
    const liabilities = of('liability');
    const equity = of('equity');
    const revenue = of('revenue');
    const expenses = of('expense');

    const claims = subtractMoney(addMoney(addMoney(liabilities, equity), revenue), expenses);
    const difference = subtractMoney(assets, claims);

    return {
      organizationId: input.organizationId,
      currency: input.currency,
      asOf,
      assets,
      liabilities,
      equity,
      revenue,
      expenses,
      difference,
      balanced: difference.amount.units === 0n,
      generatedAt: this.now(),
    };
  }

  private moneyOf(amount: { currency: string; amount: string }): Money {
    return {
      currency: amount.currency,
      amount: parseAmount(amount.amount),
    };
  }
}

/** Parses a stored decimal string without going through a float. */
function parseAmount(value: string): { units: bigint; scale: number } {
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const negative = value.startsWith('-');
  const units = BigInt(`${negative ? '-' : ''}${whole}${fraction}`);

  return { units, scale: fraction.length };
}

// ---------------------------------------------------------------------------
// Export formats
// ---------------------------------------------------------------------------

/**
 * CSV.
 *
 * **Every cell is escaped against formula injection.** A value beginning `=`, `+`, `-` or `@` is a
 * formula that executes when the file is opened, and a financial export is the one file guaranteed
 * to be opened in a spreadsheet. This is the same rule as `@trustos/export` and it is repeated
 * here rather than imported, because a report that skipped it would be a report somebody opens.
 */
export function toCsv(
  rows: Array<Record<string, string | number | null>>,
  columns?: string[],
): string {
  if (rows.length === 0) return '';

  const headers = columns ?? Object.keys(rows[0]!);
  const lines = [headers.map(escapeCell).join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => escapeCell(row[header] ?? '')).join(','));
  }

  return lines.join('\n');
}

function escapeCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);

  // Neutralise a leading formula character before quoting. A leading apostrophe is what
  // spreadsheets treat as "this is text".
  const neutralised = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return /[",\n\r]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

/** A trial balance as CSV rows. */
export function trialBalanceRows(report: TrialBalanceReport): Array<Record<string, string>> {
  return report.lines.map((line) => ({
    account_code: line.accountCode,
    account_name: line.accountName,
    class: line.accountClass,
    currency: line.currency,
    debits: formatDecimal(line.debits.amount),
    credits: formatDecimal(line.credits.amount),
    balance: formatDecimal(line.balance.amount),
  }));
}

/** A general ledger as CSV rows. */
export function generalLedgerRows(report: GeneralLedgerReport): Array<Record<string, string>> {
  return report.lines.map((line) => ({
    date: line.effectiveAt.toISOString(),
    journal_id: line.journalId,
    reference: line.reference ?? '',
    description: line.description,
    debit: line.direction === 'debit' ? formatDecimal(line.amount.amount) : '',
    credit: line.direction === 'credit' ? formatDecimal(line.amount.amount) : '',
    balance: formatDecimal(line.runningBalance.amount),
  }));
}

/**
 * The document-rendering seam.
 *
 * **The framework ships CSV and nothing else.** Excel needs a spreadsheet library and PDF needs a
 * rendering engine; both are dependencies with their own security surface, and which one to use is
 * a decision that belongs to the deployment. An application wires a renderer and gets the same
 * report in whatever format its auditors want.
 */
export interface ReportRenderer {
  readonly format: string;
  readonly contentType: string;
  render(input: {
    title: string;
    rows: Array<Record<string, string>>;
    columns?: string[];
    metadata?: Record<string, string>;
  }): Promise<Uint8Array | string>;
}

/** The CSV renderer. The only one that ships. */
export const csvRenderer: ReportRenderer = {
  format: 'csv',
  contentType: 'text/csv; charset=utf-8',
  async render(input) {
    return toCsv(input.rows, input.columns);
  },
};

/**
 * Renders with whichever renderer is registered for a format.
 *
 * Names what is available when one is not, rather than falling back to CSV silently — an auditor
 * who asked for a PDF and received a CSV will ask why, and "it fell back" is not an answer.
 */
export class ReportExporter {
  private readonly renderers = new Map<string, ReportRenderer>();

  constructor(renderers: ReportRenderer[] = [csvRenderer]) {
    for (const renderer of renderers) this.renderers.set(renderer.format, renderer);
  }

  register(renderer: ReportRenderer): void {
    this.renderers.set(renderer.format, renderer);
  }

  formats(): string[] {
    return [...this.renderers.keys()].sort();
  }

  async render(input: {
    format: string;
    title: string;
    rows: Array<Record<string, string>>;
    columns?: string[];
    metadata?: Record<string, string>;
  }): Promise<{ contentType: string; body: Uint8Array | string }> {
    const renderer = this.renderers.get(input.format);

    if (!renderer) {
      throw ApiError.validation(
        [
          {
            path: 'format',
            message:
              `No renderer is registered for "${input.format}". Available: ` +
              `${this.formats().join(', ')}. The framework ships CSV only — Excel needs a ` +
              'spreadsheet library and PDF a rendering engine, and which one is a deployment ' +
              'decision.',
          },
        ],
        `Cannot render a ${input.format} report.`,
      );
    }

    return {
      contentType: renderer.contentType,
      body: await renderer.render(input),
    };
  }
}

/** A statement line, for a customer-facing wallet statement. */
export interface StatementLine {
  at: Date;
  description: string;
  reference: string | null;
  /** Signed from the account holder's point of view: positive is money in. */
  amount: Money;
  balance: Money;
}

/**
 * A wallet statement.
 *
 * The customer-facing view, which differs from the general ledger in one important way: the
 * amounts are signed from the *holder's* point of view. A customer reading "debit 50.00" on their
 * own statement reads it as money arriving, because that is what a bank statement means to them —
 * and the accounting sense is the opposite.
 */
export function toStatement(report: GeneralLedgerReport, holderClass: string): StatementLine[] {
  return report.lines.map((line) => {
    const increases = NORMAL_SIDE[holderClass as keyof typeof NORMAL_SIDE] === line.direction;

    return {
      at: line.effectiveAt,
      description: line.description,
      reference: line.reference,
      amount: increases
        ? line.amount
        : {
            currency: line.amount.currency,
            amount: { ...line.amount.amount, units: -line.amount.amount.units },
          },
      balance: line.runningBalance,
    };
  });
}

/** A one-line summary for a report header. */
export function describeReport(report: {
  generatedAt: Date;
  organizationId: string | null;
}): string {
  return `Generated ${report.generatedAt.toISOString()} for ${report.organizationId ?? 'the platform'}`;
}

/** Formats money for a report cell: the amount only, with the currency in a column header. */
export function reportAmount(amount: Money): string {
  return formatDecimal(amount.amount);
}

/** Formats money for a report line that mixes currencies. */
export function reportMoney(amount: Money): string {
  return formatMoney(amount);
}

/** Account codes and names, for a report legend. */
export function accountLegend(accounts: Account[]): Array<Record<string, string>> {
  return accounts.map((account) => ({
    code: account.code,
    name: account.name,
    type: account.type,
    class: account.class,
    currency: account.currency,
    status: account.status,
  }));
}
