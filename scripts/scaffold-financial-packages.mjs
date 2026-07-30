#!/usr/bin/env node
/**
 * Scaffolds the phase 8 financial packages.
 *
 * Fifteen packages of the same shape. Generating the skeleton means the shape cannot drift
 * between them, and adding a dependency is one edit to the data below rather than three files
 * edited by hand and one forgotten.
 *
 * Only the skeleton is generated — package.json, tsconfig, and the build/test wiring. The source
 * is written by hand, because that is where the thinking is.
 *
 *   node scripts/scaffold-financial-packages.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The packages, in dependency order.
 *
 * A package that appears above another cannot depend on it. The order is also the order they were
 * written, and it is not arbitrary: `financial-core` defines money, and nothing else in the phase
 * can be written until "how much" has an exact answer.
 */
const PACKAGES = [
  {
    name: 'financial-core',
    description:
      'Money, currency, fixed-point decimals, rounding, allocation and financial identifiers. No floating point.',
    deps: ['errors', 'shared-types'],
  },
  {
    name: 'ledger',
    description:
      'Double-entry bookkeeping: journals, postings, reversal and trial balance. Posted journals are immutable.',
    deps: ['audit', 'errors', 'financial-core', 'logging', 'shared-types'],
  },
  {
    name: 'accounts',
    description:
      'The account tree: customer, merchant, system, settlement, suspense, fee and reserve accounts.',
    deps: ['audit', 'errors', 'financial-core', 'ledger', 'logging', 'shared-types'],
  },
  {
    name: 'fx',
    description:
      'Exchange rates, conversion with spread, rate sources and historical lookup. No live integration.',
    deps: ['errors', 'financial-core', 'logging', 'shared-types'],
  },
  {
    name: 'fees',
    description:
      'The fee engine: flat, percentage, tiered, capped, tax, discount and promotional fees, versioned.',
    deps: ['errors', 'financial-core', 'logging', 'shared-types'],
  },
  {
    name: 'limits',
    description:
      'The limit engine: per-transaction, daily, monthly, velocity, wallet and organization limits.',
    deps: ['errors', 'financial-core', 'logging', 'shared-types'],
  },
  {
    name: 'financial-policy',
    description:
      'Per-tenant financial policy: allowed currencies, overdraft, approval thresholds, settlement windows.',
    deps: ['errors', 'financial-core', 'shared-types'],
  },
  {
    name: 'financial-events',
    description: 'The financial event catalog: wallets, transactions, journals, settlement, limits.',
    deps: ['errors', 'event-sdk', 'financial-core', 'shared-types'],
  },
  {
    name: 'financial-risk',
    description:
      'Risk and compliance extension points: AML, fraud, sanctions, KYC, travel rule. No detection engine.',
    deps: ['errors', 'financial-core', 'logging', 'shared-types'],
  },
  {
    name: 'wallet',
    description:
      'Ledger-backed wallets: available, held and reserved balances, freeze, holds and history.',
    deps: [
      'accounts',
      'audit',
      'errors',
      'financial-core',
      'ledger',
      'limits',
      'logging',
      'shared-types',
    ],
  },
  {
    name: 'transactions',
    description:
      'The transaction lifecycle: authorize, capture, complete, reverse and refund, with idempotency.',
    deps: [
      'accounts',
      'audit',
      'errors',
      'fees',
      'financial-core',
      'financial-policy',
      'financial-risk',
      'ledger',
      'limits',
      'logging',
      'shared-types',
      'wallet',
    ],
  },
  {
    name: 'payments',
    description:
      'Payment requests: expiry, status, callbacks, idempotency and provider references. No providers.',
    deps: [
      'audit',
      'errors',
      'financial-core',
      'logging',
      'shared-types',
      'transactions',
    ],
  },
  {
    name: 'settlement',
    description:
      'Settlement batches, instructions, windows and adjustments. Asynchronous by construction.',
    deps: [
      'accounts',
      'audit',
      'errors',
      'financial-core',
      'ledger',
      'logging',
      'shared-types',
    ],
  },
  {
    name: 'reconciliation',
    description:
      'Internal and external reconciliation: matching, tolerance rules, exception queue and resolution.',
    deps: ['audit', 'errors', 'financial-core', 'ledger', 'logging', 'shared-types'],
  },
  {
    name: 'financial-reporting',
    description:
      'General ledger, trial balance, wallet, transaction, settlement and fee reports, with CSV and Excel.',
    deps: [
      'accounts',
      'errors',
      'financial-core',
      'ledger',
      'logging',
      'shared-types',
      'wallet',
    ],
  },
];

const NEST_PEERS = {
  peerDependencies: { '@nestjs/common': '^11.0.0', '@nestjs/core': '^11.0.0' },
  peerDependenciesMeta: {
    '@nestjs/common': { optional: true },
    '@nestjs/core': { optional: true },
  },
  devDependencies: { '@nestjs/common': '^11.1.28', '@nestjs/core': '^11.1.28' },
};

function packageJson(entry) {
  const dependencies = Object.fromEntries(
    entry.deps
      .map((dep) => [`@trustos/${dep}`, '0.1.0'])
      .concat([['zod', '^3.24.1']])
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  return `${JSON.stringify(
    {
      name: `@trustos/${entry.name}`,
      version: '0.1.0',
      private: true,
      description: entry.description,
      license: 'UNLICENSED',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      files: entry.nest ? ['dist', 'nest'] : ['dist'],
      scripts: { build: 'tsc -b', clean: 'tsc -b --clean' },
      dependencies,
      ...(entry.nest ? NEST_PEERS : {}),
    },
    null,
    2,
  )}\n`;
}

function tsconfig(entry) {
  return `${JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        rootDir: 'src',
        outDir: 'dist',
        tsBuildInfoFile: 'dist/.tsbuildinfo',
      },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'dist', 'node_modules'],
      references: entry.deps
        .map((dep) => ({ path: `../${dep}` }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  )}\n`;
}

let created = 0;

for (const entry of PACKAGES) {
  const base = join(root, 'packages', entry.name);
  mkdirSync(join(base, 'src'), { recursive: true });

  writeFileSync(join(base, 'package.json'), packageJson(entry));
  writeFileSync(join(base, 'tsconfig.json'), tsconfig(entry));

  created += 1;
}

// --- build graph -----------------------------------------------------------

const buildConfigPath = join(root, 'tsconfig.build.json');
const buildConfig = JSON.parse(readFileSync(buildConfigPath, 'utf8'));
const references = new Set(buildConfig.references.map((reference) => reference.path));

for (const entry of PACKAGES) references.add(`./packages/${entry.name}`);

buildConfig.references = [...references].sort().map((path) => ({ path }));
writeFileSync(buildConfigPath, `${JSON.stringify(buildConfig, null, 2)}\n`);

// --- vitest aliases --------------------------------------------------------
//
// Without an alias, a test importing `@trustos/ledger` resolves the built `dist` rather than the
// source — so a change is invisible to the test until a rebuild, which is exactly the feedback
// loop nobody notices is broken.

const vitestPath = join(root, 'vitest.config.ts');
let vitest = readFileSync(vitestPath, 'utf8');
const missing = PACKAGES.filter((entry) => !vitest.includes(`'@trustos/${entry.name}':`));

if (missing.length > 0) {
  const marker = "      '@trustos/ai-workflows': pkg('ai-workflows'),";
  if (!vitest.includes(marker)) {
    throw new Error(
      'Could not find the alias insertion point in vitest.config.ts. Update this script if the ' +
        'config was reorganised.',
    );
  }

  const additions = missing
    .map((entry) => `      '@trustos/${entry.name}': pkg('${entry.name}'),`)
    .join('\n');

  vitest = vitest.replace(
    marker,
    `${marker}\n\n      // Phase 8 — the financial platform.\n${additions}`,
  );
  writeFileSync(vitestPath, vitest);
}

console.log(`${created} package(s) scaffolded.`);
console.log(`${missing.length} vitest alias(es) added.`);
console.log(`build graph: ${buildConfig.references.length} references.`);
