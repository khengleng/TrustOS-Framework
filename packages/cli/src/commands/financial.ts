import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODULE_CATALOG } from '@trustos/module-registry';
import { CurrencyRegistry, formatDecimal, parseDecimal } from '@trustos/financial-core';
import { formatRows, style, type Output } from '../output';

/**
 * `trustos financial doctor`.
 *
 * Static analysis of an application's financial wiring: what is installed, what is declared, and
 * the specific mistakes that are silent until money is involved.
 *
 * **Offline**, like every other doctor in this CLI: no database, no network, nothing started. That
 * is what makes it usable on a laptop against a checkout, which is when somebody asks.
 *
 * The checks fall into three groups, and the third is the reason the command exists:
 *
 *   1. **Installation** — is the module there, is its dependency there, is it wired.
 *   2. **Schema** — does the framework schema copy carry the financial tables, *and the triggers*.
 *   3. **Money-specific mistakes** — a float in a monetary field, a currency the policy does not
 *      permit, an account tree with no suspense account. Each of these produces a system that
 *      works and is wrong.
 */

export interface FinancialDoctorOptions {
  path?: string;
  json?: boolean;
  verbose?: boolean;
}

export interface FinancialFinding {
  area: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
  detail: string;
  remediation?: string;
}

export interface FinancialDoctorReport {
  applicationRoot: string | null;
  installed: string[];
  findings: FinancialFinding[];
  ok: boolean;
}

const FINANCIAL_MODULE_IDS = ['ledger', 'wallet', 'transactions', 'settlement', 'reconciliation'];

/** Where an application conventionally keeps its financial configuration. */
const LOCATIONS = {
  currencies: ['financial/currencies.json', 'config/financial/currencies.json'],
  accounts: ['financial/accounts.json', 'config/financial/accounts.json'],
  policy: ['financial/policy.json', 'config/financial/policy.json'],
};

export async function runFinancialDoctor(
  options: FinancialDoctorOptions,
  output: Output,
): Promise<number> {
  const applicationRoot = options.path ?? findApplicationRoot(process.cwd());

  if (!applicationRoot) {
    output.error('No trustos.json found in this directory or any parent.');
    output.blank();
    output.detail('  Run this inside a generated application, or pass --path <dir>.');
    return 1;
  }

  const packageJson = await readJson(join(applicationRoot, 'package.json'));
  const dependencies = {
    ...((packageJson?.dependencies as Record<string, string>) ?? {}),
    ...((packageJson?.devDependencies as Record<string, string>) ?? {}),
  };

  const installed = FINANCIAL_MODULE_IDS.filter((id) => `@trustos/module-${id}` in dependencies);
  const findings: FinancialFinding[] = [];

  if (installed.length === 0) {
    findings.push({
      area: 'installed modules',
      status: 'INFO',
      detail: 'No financial modules are installed.',
      remediation: `Install one with: trustos add-module ${FINANCIAL_MODULE_IDS.join('|')}`,
    });
  } else {
    findings.push({
      area: 'installed modules',
      status: 'PASS',
      detail: `${installed.length} installed: ${installed.join(', ')}.`,
    });
  }

  findings.push(...checkDependencies(installed));
  findings.push(...(await checkWiring(applicationRoot, installed)));
  findings.push(...(await checkSchema(applicationRoot, installed)));
  findings.push(...(await checkMigrations(applicationRoot, installed)));
  findings.push(...(await checkCurrencies(applicationRoot, installed)));
  findings.push(...(await checkAccountTree(applicationRoot, installed)));
  findings.push(...(await checkForFloats(applicationRoot, installed)));

  const report: FinancialDoctorReport = {
    applicationRoot,
    installed,
    findings,
    ok: findings.every((finding) => finding.status !== 'FAIL'),
  };

  if (options.json) {
    output.info(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  print(report, output, options.verbose === true);
  return report.ok ? 0 : 1;
}

function checkDependencies(installed: string[]): FinancialFinding[] {
  const present = new Set(installed);
  const findings: FinancialFinding[] = [];

  for (const id of installed) {
    const entry = MODULE_CATALOG.find((candidate) => candidate.metadata.id === id);
    if (!entry) continue;

    for (const dependency of entry.dependencies) {
      if (present.has(dependency.moduleId)) continue;

      findings.push({
        area: `${id} dependencies`,
        status: 'FAIL',
        detail: `${id} needs ${dependency.moduleId}, which is not installed. ${dependency.reason}`,
        remediation: `trustos add-module ${dependency.moduleId}`,
      });
    }
  }

  if (findings.length === 0 && installed.length > 0) {
    findings.push({
      area: 'module dependencies',
      status: 'PASS',
      detail: 'Every installed financial module has its dependencies.',
    });
  }

  return findings;
}

async function checkWiring(
  applicationRoot: string,
  installed: string[],
): Promise<FinancialFinding[]> {
  if (installed.length === 0) return [];

  const sources = await readCompositionRoots(applicationRoot);

  if (sources === null) {
    return [
      {
        area: 'wiring',
        status: 'WARN',
        detail: 'No composition root found, so financial wiring could not be checked.',
      },
    ];
  }

  const findings: FinancialFinding[] = [];

  for (const id of installed) {
    const entry = MODULE_CATALOG.find((candidate) => candidate.metadata.id === id);
    if (!entry) continue;
    if (sources.includes(entry.packaging.nestModule.importPath)) continue;

    findings.push({
      area: `${id} wiring`,
      status: 'FAIL',
      detail: `${id} is installed but never imported, so it does nothing.`,
      remediation:
        `Import ${entry.packaging.nestModule.className} from ` +
        `'${entry.packaging.nestModule.importPath}' in the composition root.`,
    });
  }

  /*
   * Wallets with no limit engine.
   *
   * Not a failure — a deployment may genuinely have no limits — but worth saying, because the
   * usual reason is that nobody wired one rather than that somebody decided not to.
   */
  if (installed.includes('wallet') && !/LimitEngine/.test(sources)) {
    findings.push({
      area: 'limits',
      status: 'WARN',
      detail:
        'No limit engine is wired, so no wallet has a spending ceiling. That is a legitimate ' +
        'configuration and it is usually an omission.',
      remediation: 'Wire LimitEngine from @trustos/limits, or record that limits are deliberate.',
    });
  }

  if (findings.length === 0 && installed.length > 0) {
    findings.push({
      area: 'wiring',
      status: 'PASS',
      detail: 'Every installed financial module is imported.',
    });
  }

  return findings;
}

async function checkSchema(
  applicationRoot: string,
  installed: string[],
): Promise<FinancialFinding[]> {
  if (installed.length === 0) return [];

  const schemaPath = join(applicationRoot, 'prisma/schema/00-framework.prisma');

  if (!existsSync(schemaPath)) {
    return [
      {
        area: 'schema',
        status: 'WARN',
        detail:
          'No prisma/schema/00-framework.prisma, so the financial tables could not be checked.',
      },
    ];
  }

  const schema = await readFile(schemaPath, 'utf8');

  const REQUIRED: Record<string, string[]> = {
    ledger: [
      'LedgerJournal',
      'LedgerEntry',
      'FinancialAccount',
      'FinancialPolicy',
      'AccountingPeriod',
    ],
    wallet: ['Wallet', 'WalletHold'],
    transactions: [
      'FinancialTransaction',
      'FinancialTransactionEvent',
      'PaymentRequest',
      'FeeSchedule',
      'FinancialLimit',
      'ExchangeRate',
    ],
    settlement: ['SettlementBatch', 'SettlementInstruction', 'SettlementAdjustment'],
    reconciliation: ['ReconciliationRun', 'ReconciliationException'],
  };

  const findings: FinancialFinding[] = [];

  for (const id of installed) {
    const missing = (REQUIRED[id] ?? []).filter(
      (model) => !new RegExp(`^model ${model} \\{`, 'm').test(schema),
    );

    if (missing.length === 0) continue;

    findings.push({
      area: `${id} schema`,
      status: 'FAIL',
      detail: `The framework schema copy is missing: ${missing.join(', ')}.`,
      remediation:
        'This application was generated before the financial platform. Re-run ' +
        '`node scripts/sync-schema-fragments.mjs` in the framework, copy ' +
        'prisma/schema/00-framework.prisma across, and run a migration.',
    });
  }

  /*
   * Money stored as a float.
   *
   * The single most damaging mistake in the phase, and it is invisible: a `Float` column accepts
   * every value, agrees with every test, and disagrees with the counterparty once in ten thousand
   * transactions.
   */
  const floatColumns = [...schema.matchAll(/^\s*(\w*[Aa]mount\w*|balance|rate|fee)\s+Float/gm)];

  if (floatColumns.length > 0) {
    findings.push({
      area: 'schema precision',
      status: 'FAIL',
      detail:
        `${floatColumns.length} monetary column(s) are declared Float: ` +
        `${floatColumns.map((match) => match[1]).join(', ')}. A float agrees with every test and ` +
        'disagrees with the counterparty once in ten thousand transactions.',
      remediation: 'Use Decimal @db.Decimal(28, 8), as the framework schema does.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      area: 'schema',
      status: 'PASS',
      detail: 'The framework schema copy has every financial table, and no monetary float.',
    });
  }

  return findings;
}

/**
 * Whether the ledger's database-level guarantees are present.
 *
 * The balancing trigger and the immutability triggers are in a hand-written migration, not in the
 * Prisma schema — so an application that copied the schema and generated its own migration has
 * the tables and none of the guarantees. Everything works, and the one thing the ledger is for
 * quietly does not.
 */
async function checkMigrations(
  applicationRoot: string,
  installed: string[],
): Promise<FinancialFinding[]> {
  if (!installed.includes('ledger')) return [];

  const migrationsRoot = join(applicationRoot, 'prisma/migrations');

  if (!existsSync(migrationsRoot)) {
    return [
      {
        area: 'ledger guarantees',
        status: 'WARN',
        detail: 'No prisma/migrations directory, so the ledger triggers could not be checked.',
      },
    ];
  }

  const { readdir } = await import('node:fs/promises');
  const directories = await readdir(migrationsRoot);
  let combined = '';

  for (const directory of directories) {
    const file = join(migrationsRoot, directory, 'migration.sql');
    if (!existsSync(file)) continue;
    combined += await readFile(file, 'utf8');
  }

  const missing: string[] = [];

  if (!combined.includes('trustos_journal_must_balance')) missing.push('the balancing trigger');
  if (!combined.includes('trustos_journal_immutable'))
    missing.push('the journal immutability trigger');
  if (!combined.includes('trustos_entry_immutable')) missing.push('the entry immutability trigger');
  if (!combined.includes('ledger_entry_amount_positive')) missing.push('the positive-amount check');

  /*
   * Two periods covering the same day are two answers to "was this month closed", and the
   * application picks whichever it read first. Only the exclusion constraint can prevent it —
   * a check in code loses the race.
   */
  if (!combined.includes('accounting_period_no_overlap'))
    missing.push('the period non-overlap constraint');

  /*
   * The kind/expiry rule. Without it a reserve can be written with an expiry, the sweeper
   * releases it on schedule, and a rolling reserve silently stops covering anything.
   */
  if (installed.includes('wallet') && !combined.includes('wallet_hold_expiry_matches_kind'))
    missing.push('the hold expiry check');

  if (missing.length > 0) {
    return [
      {
        area: 'ledger guarantees',
        status: 'FAIL',
        detail:
          `The migrations do not contain ${missing.join(', ')}. The tables exist and the ` +
          'guarantees do not, so the database would accept what they exist to refuse — an ' +
          'unbalanced journal, an edited posting, two periods covering the same day, a reserve ' +
          'the sweeper will release.',
        remediation:
          'Copy the hand-written sections of 20261101000000_phase8_financial_platform and ' +
          '20261115000000_phase8_closing_reserves_adjustments from the framework into migrations ' +
          'of your own.',
      },
    ];
  }

  return [
    {
      area: 'ledger guarantees',
      status: 'PASS',
      detail:
        'Balancing, immutability, positive-amount, period-overlap and hold-expiry constraints ' +
        'are all in the migrations.',
    },
  ];
}

async function checkCurrencies(
  applicationRoot: string,
  installed: string[],
): Promise<FinancialFinding[]> {
  if (installed.length === 0) return [];

  const loaded = await loadJsonFrom(applicationRoot, LOCATIONS.currencies);

  if (!loaded) {
    return [
      {
        area: 'currencies',
        status: 'INFO',
        detail:
          'No currency configuration found. The framework ships eight well-known definitions and ' +
          'no complete ISO 4217 table, because a partial list that looks complete is worse than none.',
        remediation: `Add one at ${LOCATIONS.currencies[0]}, or register currencies in code.`,
      },
    ];
  }

  const entries = Array.isArray(loaded.contents)
    ? loaded.contents
    : ((loaded.contents as { currencies?: unknown[] })?.currencies ?? []);

  const registry = new CurrencyRegistry([]);
  const problems: string[] = [];

  for (const entry of entries) {
    try {
      registry.register(entry);
    } catch (error) {
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      problems.push(details.map((detail) => detail.message).join('; ') || String(error));
    }
  }

  if (problems.length > 0) {
    return problems.map((problem) => ({
      area: 'currencies',
      status: 'FAIL' as const,
      detail: problem,
    }));
  }

  /*
   * A currency with the wrong number of minor units.
   *
   * KHR and JPY have none. An amount stored at two decimal places in a currency that has none
   * carries precision the currency does not have, and it will be non-zero after a percentage fee —
   * so a total that should be a whole number is not.
   */
  const suspicious = registry
    .list()
    .filter(
      (currency) => ['KHR', 'JPY', 'VND', 'KRW'].includes(currency.code) && currency.exponent !== 0,
    );

  if (suspicious.length > 0) {
    return [
      {
        area: 'currencies',
        status: 'FAIL',
        detail:
          `${suspicious.map((currency) => `${currency.code} has exponent ${currency.exponent}`).join(', ')}. ` +
          'These currencies have no minor unit, so an amount stored with decimal places carries ' +
          'precision the currency does not have — and it will be non-zero after a percentage fee.',
        remediation: 'Set exponent to 0 for these currencies.',
      },
    ];
  }

  return [
    {
      area: 'currencies',
      status: 'PASS',
      detail: `${registry.list().length} currency definition(s) in ${loaded.path}, all valid.`,
    },
  ];
}

/**
 * Whether the account tree has the accounts a real system needs.
 *
 * A suspense account is the one worth checking. Every financial system receives money it cannot
 * identify, and a system without a suspense account puts it somewhere it does not belong — usually
 * a revenue account, where it is very hard to get back out.
 */
async function checkAccountTree(
  applicationRoot: string,
  installed: string[],
): Promise<FinancialFinding[]> {
  if (!installed.includes('ledger')) return [];

  const loaded = await loadJsonFrom(applicationRoot, LOCATIONS.accounts);

  if (!loaded) {
    return [
      {
        area: 'account tree',
        status: 'INFO',
        detail: 'No account configuration found. Accounts may be opened in code at start-up.',
        remediation: `Add one at ${LOCATIONS.accounts[0]}, or open accounts in a seed.`,
      },
    ];
  }

  const accounts = (
    Array.isArray(loaded.contents)
      ? loaded.contents
      : ((loaded.contents as { accounts?: unknown[] })?.accounts ?? [])
  ) as Array<{ type?: string; code?: string }>;

  const types = new Set(accounts.map((account) => account.type));
  const findings: FinancialFinding[] = [];

  if (!types.has('suspense')) {
    findings.push({
      area: 'account tree',
      status: 'WARN',
      detail:
        'There is no suspense account. Every financial system receives money it cannot identify, ' +
        'and a system without one puts it somewhere it does not belong — usually revenue, where ' +
        'it is very hard to get back out.',
      remediation: 'Open a suspense account per currency.',
    });
  }

  if (installed.includes('settlement') && !types.has('settlement')) {
    findings.push({
      area: 'account tree',
      status: 'FAIL',
      detail:
        'The settlement module is installed and there is no settlement account. A batch has ' +
        'nowhere to hold money between sending and confirmation.',
      remediation: 'Open a settlement account per currency.',
    });
  }

  if (!types.has('fee') && installed.includes('transactions')) {
    findings.push({
      area: 'account tree',
      status: 'WARN',
      detail: 'There is no fee account, so fee revenue has nowhere to be booked.',
      remediation: 'Open a fee account per currency.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      area: 'account tree',
      status: 'PASS',
      detail: `${accounts.length} account(s) in ${loaded.path}, including the ones a real system needs.`,
    });
  }

  return findings;
}

/**
 * Looks for a float where money should be.
 *
 * A crude scan of the product's own source, and it is worth running anyway: `parseFloat` and
 * `Number(` applied to an amount is the single most damaging mistake available in this phase, and
 * it produces a system that passes every test.
 */
async function checkForFloats(
  applicationRoot: string,
  installed: string[],
): Promise<FinancialFinding[]> {
  if (installed.length === 0) return [];

  const { readdir } = await import('node:fs/promises');
  const roots = ['src', 'apps'].map((directory) => join(applicationRoot, directory));
  const hits: string[] = [];

  async function walk(directory: string, depth = 0): Promise<void> {
    if (depth > 6 || !existsSync(directory)) return;

    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;

      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }

      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;

      const source = await readFile(path, 'utf8');

      // `parseFloat` or `Number(...)` within a few characters of something money-shaped.
      const pattern =
        /(parseFloat\s*\(|Number\s*\()\s*[^)]*\b(amount|balance|fee|price|total|rate)\b/i;

      if (pattern.test(source)) {
        hits.push(path.slice(applicationRoot.length + 1));
      }
    }
  }

  for (const root of roots) await walk(root);

  if (hits.length === 0) {
    return [
      {
        area: 'precision',
        status: 'PASS',
        detail: 'No floating-point arithmetic found near a monetary value.',
      },
    ];
  }

  return [
    {
      area: 'precision',
      status: 'FAIL',
      detail:
        `${hits.length} file(s) apply parseFloat or Number() to something money-shaped: ` +
        `${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''}. This produces a system ` +
        'that agrees with every test and disagrees with the counterparty.',
      remediation:
        'Use parseDecimal and the Money helpers from @trustos/financial-core. See docs/financial-architecture.md.',
    },
  ];
}

async function readCompositionRoots(applicationRoot: string): Promise<string | null> {
  const paths = [
    'apps/api/src/app.module.ts',
    'src/app.module.ts',
    'apps/worker/src/worker.module.ts',
  ]
    .map((relative) => join(applicationRoot, relative))
    .filter((path) => existsSync(path));

  if (paths.length === 0) return null;

  return (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');
}

async function loadJsonFrom(
  applicationRoot: string,
  candidates: string[],
): Promise<{ path: string; contents: unknown } | null> {
  for (const relative of candidates) {
    const path = join(applicationRoot, relative);
    if (!existsSync(path)) continue;

    const contents = await readJson(path);
    if (contents !== null) return { path: relative, contents };
  }

  return null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findApplicationRoot(from: string): string | null {
  let current = from;

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'trustos.json'))) return current;

    const parent = join(current, '..');
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function print(report: FinancialDoctorReport, output: Output, verbose: boolean): void {
  output.info(style.bold('Financial platform'));
  output.detail(`  ${report.applicationRoot}`);
  output.blank();

  output.info(
    formatRows(
      report.findings.map((finding): [string, string] => [
        `${finding.status.padEnd(4)}  ${finding.area}`,
        finding.detail,
      ]),
    ),
  );

  const actionable = report.findings.filter((finding) => finding.remediation);

  if (actionable.length > 0) {
    output.blank();
    output.info(style.bold('What to do'));
    for (const finding of actionable) {
      output.detail(`  ${finding.area}: ${finding.remediation}`);
    }
  }

  if (verbose) {
    output.blank();
    output.info(style.bold('What this cannot see'));
    output.detail('  Whether the ledger actually balances — that needs a database.');
    output.detail('  Whether a limit is set at a sensible number for this business.');
    output.detail('  Whether anybody is working the reconciliation exception queue.');
    output.detail('  Whether the fee schedules match what customers were told.');
  }

  output.blank();
  output.info(
    report.ok ? style.bold('No blocking problems.') : style.bold('Blocking problems found.'),
  );
}

/** Formats a decimal for the report, without going through a float. */
export function safeAmount(value: string): string {
  try {
    return formatDecimal(parseDecimal(value));
  } catch {
    return value;
  }
}
