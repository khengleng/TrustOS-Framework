#!/usr/bin/env node
/**
 * Generates the five financial module packages.
 *
 * Same shape and same reasoning as the integration and AI scaffolds: each is a thin wrapper that
 * contributes the module contract — declarations, lifecycle, health — around framework packages
 * that do the work.
 *
 *   node scripts/scaffold-financial-modules.mjs
 *
 * The split between the five is by what an application is trying to do:
 *
 *   ledger          keep books: journals, accounts, trial balance, reporting.
 *   wallet          hold customer money: balances, holds, freeze.
 *   transactions    move money: the lifecycle, fees, limits, payments.
 *   settlement      pay counterparties in batches.
 *   reconciliation  check the books against somebody else's.
 *
 * Everything depends on `ledger`, because everything in the phase is ledger-backed. A wallet
 * without a ledger has a balance column, which is the design mistake the phase exists to prevent.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
  {
    id: 'ledger',
    className: 'LedgerModule',
    pascal: 'Ledger',
    title: 'Ledger',
    summary:
      'Double-entry bookkeeping: journals, accounts, reversal, trial balance and reporting. Posted journals are immutable and every journal must balance.',
    framework: [
      '@trustsystem/accounts',
      '@trustsystem/financial-core',
      '@trustsystem/financial-policy',
      '@trustsystem/financial-reporting',
      '@trustsystem/ledger',
    ],
    healthDetail: 'The ledger is reachable and its trial balance balances.',
    note:
      'Three rules are absolute and all three are enforced at the database as well as in the\n * service: a journal must balance, a posted journal is immutable, and a correction is a new\n * journal. Read the phase 8 section of the schema before changing any of them.',
    dependsOn: [],
  },
  {
    id: 'wallet',
    className: 'WalletModule',
    pascal: 'Wallet',
    title: 'Wallets',
    summary:
      'Ledger-backed customer wallets: available, held and reserved balances, holds, freeze and history.',
    framework: ['@trustsystem/financial-core', '@trustsystem/limits', '@trustsystem/wallet'],
    healthDetail: 'Wallet balances are readable and no hold has outlived its expiry unswept.',
    note:
      'A wallet is a view over a ledger account, never a balance of its own. A wallet with its own\n * balance column has two sources of truth, they disagree within a month, and the one everybody\n * reads is the wrong one.',
    dependsOn: ['ledger'],
  },
  {
    id: 'transactions',
    className: 'TransactionsModule',
    pascal: 'Transactions',
    title: 'Transactions',
    summary:
      'The transaction lifecycle with idempotency, fees, limits, risk hooks and payment requests.',
    framework: [
      '@trustsystem/fees',
      '@trustsystem/financial-core',
      '@trustsystem/financial-risk',
      '@trustsystem/fx',
      '@trustsystem/limits',
      '@trustsystem/payments',
      '@trustsystem/transactions',
    ],
    healthDetail: 'The transaction store is reachable and nothing is stuck in authorized.',
    note:
      'Every operation takes an idempotency key and the store enforces it uniquely. A client with a\n * 30-second timeout against a service with a 35-second p99 retries a meaningful fraction of\n * everything, so "retried" is the normal case rather than the exception.',
    dependsOn: ['ledger', 'wallet'],
  },
  {
    id: 'settlement',
    className: 'SettlementModule',
    pascal: 'Settlement',
    title: 'Settlement',
    summary:
      'Settlement batches, instructions and windows, with partial confirmation and returns. Asynchronous by construction.',
    framework: ['@trustsystem/financial-core', '@trustsystem/settlement'],
    healthDetail: 'No batch has been in transit longer than its window allows.',
    note:
      'The settlement account is the whole mechanism: money leaves a merchant and sits there until\n * the counterparty confirms. That balance is exactly what has been instructed and not paid, and\n * it is the number to check against a bank statement.',
    dependsOn: ['ledger'],
  },
  {
    id: 'reconciliation',
    className: 'ReconciliationModule',
    pascal: 'Reconciliation',
    title: 'Reconciliation',
    summary:
      'Internal and external reconciliation with tolerance rules, an exception queue and resolution history.',
    framework: ['@trustsystem/financial-core', '@trustsystem/reconciliation'],
    healthDetail: 'The exception queue is being worked and nothing has been open too long.',
    note:
      'The output is a queue, not a number. "£3.42 out" is not actionable; "these four are on the\n * statement and not in the ledger" is. Matching is by reference first, because amount-only\n * matching pairs two unrelated payments and reports a clean run.',
    dependsOn: ['ledger'],
  },
];

const SHARED_DEPENDENCIES = [
  '@trustsystem/errors',
  '@trustsystem/logging',
  '@trustsystem/module-registry',
  '@trustsystem/module-sdk',
  '@trustsystem/observability',
  '@trustsystem/shared-types',
];

const NEST_PEERS = {
  peerDependencies: { '@nestjs/common': '^11.0.0', '@nestjs/core': '^11.0.0' },
  peerDependenciesMeta: {
    '@nestjs/common': { optional: true },
    '@nestjs/core': { optional: true },
  },
  devDependencies: { '@nestjs/common': '^11.1.28', '@nestjs/core': '^11.1.28' },
};

const camel = (id) => id.replace(/-([a-z])/g, (_, character) => character.toUpperCase());

function packageJson(module) {
  const dependencies = {};

  for (const name of [
    ...SHARED_DEPENDENCIES,
    ...module.framework,
    ...module.dependsOn.map((id) => `@trustsystem/module-${id}`),
  ].sort()) {
    dependencies[name] = '0.1.0';
  }

  return `${JSON.stringify(
    {
      name: `@trustsystem/module-${module.id}`,
      version: '0.1.0',
      private: true,
      description: `TrustOS ${module.title} module. ${module.summary}`,
      license: 'UNLICENSED',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      files: ['dist', 'nest', 'install', 'README.md', 'AGENTS.md'],
      scripts: { build: 'tsc -b', clean: 'tsc -b --clean' },
      dependencies,
      ...NEST_PEERS,
    },
    null,
    2,
  )}\n`;
}

function tsconfig(module) {
  const references = [
    ...SHARED_DEPENDENCIES.map((name) => `../../${name.replace('@trustsystem/', '')}`),
    ...module.framework.map((name) => `../../${name.replace('@trustsystem/', '')}`),
    ...module.dependsOn.map((id) => `../${id}`),
  ]
    .sort()
    .map((path) => ({ path }));

  return `${JSON.stringify(
    {
      extends: '../../../tsconfig.base.json',
      compilerOptions: {
        rootDir: 'src',
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'dist', 'node_modules'],
      references,
    },
    null,
    2,
  )}\n`;
}

function moduleSource(module) {
  return `import { z } from 'zod';
import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';

/**
 * The ${module.title.toLowerCase()} module.
 *
 * ${module.summary}
 *
 * A thin wrapper. The implementation is in ${module.framework
   .map((name) => `\`${name}\``)
   .join(', ')} —
 * this package contributes the declarations the platform needs (permissions, audit events,
 * health) and the start/stop lifecycle.
 *
 * ${module.note}
 */

export const ${camel(module.id)}ConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ${module.pascal}Config = z.infer<typeof ${camel(module.id)}ConfigSchema>;

export interface ${module.pascal}Instance extends ModuleInstance {
  readonly ready: boolean;
}

export function create${module.pascal}(
  context: ModuleContext<${module.pascal}Config>,
): ${module.pascal}Instance {
  let ready = false;

  return {
    moduleId: '${module.id}',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: '${module.id}', enabled: ready },
        ready ? '${module.id} module initialized' : '${module.id} module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('${module.id}', async () =>
        ready
          ? { status: 'ok', detail: '${module.healthDetail}' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const ${camel(module.id)}Module = defineModule<${module.pascal}Config>({
  ...moduleDeclarations('${module.id}'),
  configSchema: ${camel(module.id)}ConfigSchema,
  // Every balance belongs to somebody, and a query with no tenant returns every organization's
  // money. There is no such thing as an untenanted financial module.
  tenantScoped: true,
  create: create${module.pascal},
});
`;
}

function indexSource(module) {
  return `/**
 * @trustsystem/module-${module.id}
 *
 * ${module.summary}
 *
 * The implementation lives in ${module.framework.map((name) => `\`${name}\``).join(', ')}; this
 * package is the module contract around it.
 */
export * from './${module.id}.module';
`;
}

function nestSource(module) {
  const definitionName = `${camel(module.id)}Module`;

  return `import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustsystem/module-sdk/nest';
import { ${definitionName} } from '../${module.id}.module';

/**
 * NestJS wiring for the ${module.title.toLowerCase()} module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes a store the application supplies.
 */
@Module({})
export class ${module.className} {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: ${module.className},
      providers: [...moduleProviders(${definitionName}, binding)],
      exports: [],
    };
  }
}
`;
}

function nestIndex(module) {
  return `/**
 * @trustsystem/module-${module.id}/nest
 *
 * NestJS bindings, behind a subpath so importing the module does not pull \`@nestjs/common\` into
 * a worker or a test.
 */
export * from './${module.id}.nest-module';
`;
}

function nestStub(module) {
  return `${JSON.stringify(
    {
      '//': `Subpath stub: keeps NestJS bindings out of consumers that import '@trustsystem/module-${module.id}'.`,
      name: `@trustsystem/module-${module.id}-nest`,
      private: true,
      main: '../dist/nest/index.js',
      types: '../dist/nest/index.d.ts',
    },
    null,
    2,
  )}\n`;
}

function readme(module) {
  return `# @trustsystem/module-${module.id}

${module.summary}

## What this package is

A thin module wrapper. The implementation is in ${module.framework
    .map((name) => `\`${name}\``)
    .join(', ')}; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

\`\`\`bash
trustos add-module ${module.id}
\`\`\`

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

\`\`\`ts
import { ${module.className} } from '@trustsystem/module-${module.id}/nest';

@Module({ imports: [${module.className}.forRoot(binding)] })
export class AppModule {}
\`\`\`

The financial tables are part of the framework schema, so there is no migration to run.

## What it does not do

See \`outOfScope\` in the module catalog (\`trustos list-modules --verbose\`). The short version:
this is a financial foundation, not a bank and not a payment gateway. It ships no provider
integration and no scheme implementation.
`;
}

function agents(module) {
  return `# AGENTS.md — @trustsystem/module-${module.id}

${module.summary}

## Rules

1. **The implementation belongs in the framework package**, not here. This package declares and
   wires; ${module.framework.map((name) => `\`${name}\``).join(', ')} does the work.
2. **Never modify a posted journal.** A correction is a reversal or an adjustment, both of which
   post a new journal and leave the original standing.
3. **Never use floating-point arithmetic for money.** Every amount is a fixed-point decimal, and
   the one place a float appears is a display layer that never feeds a calculation.
4. **Always validate balancing.** Debits equal credits, per currency, before anything posts.
5. **Always enforce idempotency.** Every operation that moves money takes a key, and the store
   enforces it with a unique constraint rather than a check.
6. **Always audit financial actions**: every posting, every reversal, every status change, every
   limit refusal.
7. **Never bypass limits.** No "internal caller" path that skips the limit engine.
8. **Never bypass tenant isolation.** Every store call takes \`organizationId\` explicitly.
9. **Add a test for every behaviour**, including the negative one and the concurrent one. A
   guarantee with no test that it holds under two callers is a comment.
`;
}

let written = 0;

for (const module of MODULES) {
  const base = join(root, 'packages/modules', module.id);

  const files = [
    ['package.json', packageJson(module)],
    ['tsconfig.json', tsconfig(module)],
    ['README.md', readme(module)],
    ['AGENTS.md', agents(module)],
    [`src/${module.id}.module.ts`, moduleSource(module)],
    ['src/index.ts', indexSource(module)],
    [`src/nest/${module.id}.nest-module.ts`, nestSource(module)],
    ['src/nest/index.ts', nestIndex(module)],
    ['nest/package.json', nestStub(module)],
  ];

  for (const [relative, contents] of files) {
    const target = join(base, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    written += 1;
  }

  console.log(`written    packages/modules/${module.id}  (${files.length} files)`);
}

console.log(`\n${written} file(s) across ${MODULES.length} module(s).`);
