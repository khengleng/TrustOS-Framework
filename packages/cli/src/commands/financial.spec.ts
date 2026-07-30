import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCapturingOutput } from '../output';
import { runFinancialDoctor } from './financial';

/**
 * The checks worth testing are the ones a working application passes and should not.
 *
 * A ledger with the tables and none of the triggers works perfectly. A `Float` amount column
 * accepts every value. A KHR currency with two decimal places rounds correctly in every test. All
 * three produce a system that is wrong in a way nothing surfaces until reconciliation.
 */

let root: string;

function write(relative: string, contents: string | object): void {
  const path = join(root, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
}

const MODELS: Record<string, string[]> = {
  ledger: ['LedgerJournal', 'LedgerEntry', 'FinancialAccount', 'FinancialPolicy'],
  wallet: ['Wallet', 'WalletHold'],
  transactions: [
    'FinancialTransaction',
    'FinancialTransactionEvent',
    'PaymentRequest',
    'FeeSchedule',
    'FinancialLimit',
    'ExchangeRate',
  ],
  settlement: ['SettlementBatch', 'SettlementInstruction'],
  reconciliation: ['ReconciliationRun', 'ReconciliationException'],
};

const GUARANTEES = `
CREATE OR REPLACE FUNCTION trustos_journal_must_balance() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION trustos_journal_immutable() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION trustos_entry_immutable() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_amount_positive" CHECK ("amount" > 0);
`;

/** A generated application with the financial modules installed and wired. */
function application(
  options: { modules?: string[]; wired?: boolean; guarantees?: boolean; schema?: string } = {},
): void {
  const modules = options.modules ?? ['ledger'];

  write('trustos.json', { name: 'test-app' });
  write('package.json', {
    name: 'test-app',
    dependencies: Object.fromEntries(modules.map((id) => [`@trustos/module-${id}`, '0.1.0'])),
  });

  const className = (id: string) =>
    id
      .split('-')
      .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
      .join('');

  const imports =
    options.wired === false
      ? ''
      : modules
          .map((id) => `import { ${className(id)}Module } from '@trustos/module-${id}/nest';`)
          .join('\n');

  write(
    'apps/api/src/app.module.ts',
    `${imports}\nimport { LimitEngine } from '@trustos/limits';\n@Module({})\nexport class AppModule {}\n`,
  );

  const models = modules.flatMap((id) => MODELS[id] ?? []);

  write(
    'prisma/schema/00-framework.prisma',
    options.schema ??
      models
        .map((model) => `model ${model} {\n  id String @id\n  amount Decimal @db.Decimal(28, 8)\n}`)
        .join('\n\n'),
  );

  if (options.guarantees !== false) {
    write('prisma/migrations/20261101000000_financial/migration.sql', GUARANTEES);
  } else {
    write('prisma/migrations/20261101000000_financial/migration.sql', 'CREATE TABLE x (id TEXT);');
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trustos-fin-cli-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installation', () => {
  it('refuses to guess when there is no application', async () => {
    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: undefined }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/No trustos\.json/);
  });

  it('passes on a wired application', async () => {
    application({ modules: ['ledger'] });

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(0);
  });

  it('fails when a module is installed but never imported', async () => {
    application({ modules: ['ledger'], wired: false });

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/installed but never imported/);
  });

  it('fails when wallet is installed without ledger', async () => {
    // A wallet without a ledger would need a balance column, which is two sources of truth.
    application({ modules: ['wallet'] });

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/wallet needs ledger/);
  });
});

describe('the database guarantees', () => {
  it('fails when the tables exist and the triggers do not', async () => {
    /*
     * The check this command exists for. An application that copied the schema and generated its
     * own migration has the tables and none of the guarantees — everything works, and the one
     * thing the ledger is for quietly does not.
     */
    application({ modules: ['ledger'], guarantees: false });

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(1);

    const text = output.lines.join('\n');
    expect(text).toMatch(/the balancing trigger/);
    expect(text).toMatch(/the journal immutability trigger/);
    expect(text).toMatch(/an unbalanced journal or an edited posting would be accepted/);
  });

  it('passes when every guarantee is in a migration', async () => {
    application({ modules: ['ledger'] });

    const output = createCapturingOutput();
    await runFinancialDoctor({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(
      /Balancing, immutability and positive-amount constraints are all in the migrations/,
    );
  });
});

describe('precision', () => {
  it('fails on a monetary column declared Float', async () => {
    /*
     * A float agrees with every test and disagrees with the counterparty once in ten thousand
     * transactions.
     */
    application({
      modules: ['ledger'],
      schema: MODELS.ledger!.map(
        (model) => `model ${model} {\n  id String @id\n  amount Float\n}`,
      ).join('\n\n'),
    });

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/monetary column\(s\) are declared Float/);
  });

  it('fails on parseFloat applied to an amount in the product’s own code', async () => {
    application({ modules: ['ledger'] });
    write('src/billing.ts', 'const total = parseFloat(row.amount);\nexport { total };\n');

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(
      /agrees with every test and disagrees with the counterparty/,
    );
  });

  it('does not flag a test file', async () => {
    // Fixtures legitimately build numbers; the rule is about production paths.
    application({ modules: ['ledger'] });
    write('src/billing.spec.ts', 'const total = parseFloat("1.5");\n');

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(0);
  });

  it('does not flag Number() on something that is not money', async () => {
    application({ modules: ['ledger'] });
    write('src/paging.ts', 'const page = Number(query.page);\nexport { page };\n');

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(0);
  });
});

describe('currencies', () => {
  it('fails on a zero-decimal currency configured with decimals', async () => {
    /*
     * KHR has no minor unit. Two decimal places carry precision the currency does not have, and
     * they will be non-zero after a percentage fee.
     */
    application({ modules: ['ledger'] });
    write('financial/currencies.json', [{ code: 'KHR', name: 'Cambodian riel', exponent: 2 }]);

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(/KHR has exponent 2/);
  });

  it('passes on a correct definition', async () => {
    application({ modules: ['ledger'] });
    write('financial/currencies.json', [
      { code: 'USD', name: 'United States dollar', exponent: 2 },
      { code: 'KHR', name: 'Cambodian riel', exponent: 0 },
    ]);

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/2 currency definition\(s\)/);
  });

  it('says the framework ships no complete table when none is configured', async () => {
    application({ modules: ['ledger'] });

    const output = createCapturingOutput();
    await runFinancialDoctor({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(
      /a partial list that looks complete is worse than none/,
    );
  });
});

describe('the account tree', () => {
  it('warns when there is no suspense account', async () => {
    /*
     * Every financial system receives money it cannot identify, and a system without one puts it
     * somewhere it does not belong — usually revenue, where it is very hard to get back out.
     */
    application({ modules: ['ledger'] });
    write('financial/accounts.json', [{ type: 'system', code: 'system.bank.usd' }]);

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(0);
    expect(output.lines.join('\n')).toMatch(/no suspense account/);
  });

  it('fails when settlement is installed with no settlement account', async () => {
    application({ modules: ['ledger', 'settlement'] });
    write('financial/accounts.json', [{ type: 'suspense', code: 'suspense.usd' }]);

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(1);
    expect(output.lines.join('\n')).toMatch(
      /nowhere to hold money between sending and confirmation/,
    );
  });

  it('passes on a complete tree', async () => {
    application({ modules: ['ledger', 'settlement', 'transactions', 'wallet'] });
    write('financial/accounts.json', [
      { type: 'system', code: 'system.bank.usd' },
      { type: 'suspense', code: 'suspense.usd' },
      { type: 'settlement', code: 'settlement.bank.usd' },
      { type: 'fee', code: 'fee.processing.usd' },
    ]);

    const output = createCapturingOutput();

    expect(await runFinancialDoctor({ path: root }, output)).toBe(0);
  });
});

describe('limits', () => {
  it('warns when wallets have no limit engine', async () => {
    // A legitimate configuration, and usually an omission.
    application({ modules: ['ledger', 'wallet'] });
    write(
      'apps/api/src/app.module.ts',
      "import { LedgerModule } from '@trustos/module-ledger/nest';\n" +
        "import { WalletModule } from '@trustos/module-wallet/nest';\n",
    );

    const output = createCapturingOutput();
    await runFinancialDoctor({ path: root }, output);

    expect(output.lines.join('\n')).toMatch(/no wallet has a spending ceiling/);
  });
});

describe('output', () => {
  it('says what it cannot see when asked', async () => {
    application({ modules: ['ledger'] });

    const output = createCapturingOutput();
    await runFinancialDoctor({ path: root, verbose: true }, output);

    expect(output.lines.join('\n')).toMatch(/Whether the ledger actually balances/);
  });

  it('produces machine-readable output', async () => {
    application({ modules: ['ledger'] });

    const output = createCapturingOutput();
    await runFinancialDoctor({ path: root, json: true }, output);

    const report = JSON.parse(output.lines.join('\n')) as { installed: string[]; ok: boolean };

    expect(report.installed).toEqual(['ledger']);
    expect(report.ok).toBe(true);
  });
});
