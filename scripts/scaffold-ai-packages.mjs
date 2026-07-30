#!/usr/bin/env node
/**
 * Scaffolds the phase 7 AI packages.
 *
 * Twenty-five packages of the same shape. Generating the skeleton means the shape cannot drift
 * between them, and it means adding a dependency is one edit to the data below rather than three
 * files edited by hand and one forgotten.
 *
 * Only the skeleton is generated — package.json, tsconfig, and the build/test wiring. The source
 * is written by hand, because that is where the thinking is.
 *
 *   node scripts/scaffold-ai-packages.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The packages, in dependency order.
 *
 * `deps` lists framework packages only; `zod` and the Nest peer dependencies are added where
 * declared. The order here is the order they compile in, which is also the order they were
 * written — a package that appears above another cannot depend on it.
 */
const PACKAGES = [
  {
    name: 'ai-sdk',
    description: 'The shared AI vocabulary: messages, model references, requests, results, usage.',
    deps: ['errors', 'shared-types'],
  },
  {
    name: 'token-meter',
    description: 'Token counting and budget accounting, provider-neutral.',
    deps: ['ai-sdk', 'errors', 'shared-types'],
  },
  {
    name: 'model-registry',
    description: 'The catalog of models: capabilities, context windows, pricing, availability.',
    deps: ['ai-sdk', 'errors', 'shared-types'],
  },
  {
    name: 'prompt-registry',
    description: 'Versioned, approved, immutable prompts with typed variables and output schemas.',
    deps: ['ai-sdk', 'audit', 'errors', 'logging', 'shared-types'],
  },
  {
    name: 'prompt-security',
    description: 'Prompt-injection and jailbreak detection over untrusted input.',
    deps: ['ai-sdk', 'errors', 'shared-types'],
  },
  {
    name: 'content-filter',
    description: 'PII, profanity and risk-category detection with configurable severity.',
    deps: ['ai-sdk', 'errors', 'shared-types'],
  },
  {
    name: 'guardrails',
    description: 'The safety pipeline: input checks, output validation and human-review hooks.',
    deps: ['ai-sdk', 'content-filter', 'errors', 'logging', 'prompt-security', 'shared-types'],
  },
  {
    name: 'ai-policy',
    description: 'Per-tenant policy: allowed models, tools, budgets, runtime and approval rules.',
    deps: ['ai-sdk', 'errors', 'model-registry', 'shared-types'],
  },
  {
    name: 'cost-monitor',
    description: 'Cost accounting per tenant, application, model and day, with budgets and alerts.',
    deps: ['ai-sdk', 'errors', 'logging', 'model-registry', 'shared-types', 'token-meter'],
  },
  {
    name: 'ai-cache',
    description: 'Prompt, response and embedding caches with TTL, invalidation and metrics.',
    deps: ['ai-sdk', 'errors', 'logging', 'shared-types'],
  },
  {
    name: 'model-router',
    description: 'Chooses a model from a requirement, with fallback and tenant policy.',
    deps: ['ai-sdk', 'ai-policy', 'errors', 'logging', 'model-registry', 'shared-types'],
  },
  {
    name: 'ai-gateway',
    description: 'The single path to a provider: validation, policy, guardrails, retry, cost.',
    deps: [
      'ai-cache',
      'ai-policy',
      'ai-sdk',
      'audit',
      'cost-monitor',
      'errors',
      'guardrails',
      'logging',
      'model-registry',
      'model-router',
      'observability',
      'provider-sdk',
      'retry',
      'shared-types',
      'token-meter',
    ],
    nest: true,
  },
  {
    name: 'embedding',
    description: 'Embedding provider abstraction with dimension and metric tracking.',
    deps: ['ai-sdk', 'errors', 'model-registry', 'provider-sdk', 'retry', 'shared-types'],
  },
  {
    name: 'vector-store',
    description: 'Vector storage abstraction: upsert, search, filter, delete. In-memory default.',
    deps: ['ai-sdk', 'embedding', 'errors', 'shared-types'],
  },
  {
    name: 'knowledge',
    description: 'Knowledge collections and documents with versions, access policy and expiry.',
    deps: ['ai-sdk', 'audit', 'errors', 'logging', 'shared-types', 'vector-store'],
  },
  {
    name: 'rag',
    description: 'Loading, chunking, retrieval, ranking and citation over a vector store.',
    deps: [
      'ai-sdk',
      'embedding',
      'errors',
      'knowledge',
      'logging',
      'shared-types',
      'vector-store',
    ],
  },
  {
    name: 'function-calling',
    description: 'Typed function definitions, argument validation and invocation results.',
    deps: ['ai-sdk', 'errors', 'shared-types'],
  },
  {
    name: 'tool-execution',
    description: 'The tool registry and executor: permissions, timeouts, audit, health.',
    deps: [
      'ai-sdk',
      'audit',
      'authorization',
      'errors',
      'function-calling',
      'logging',
      'observability',
      'retry',
      'shared-types',
    ],
  },
  {
    name: 'agent-memory',
    description: 'Conversation, session, user, organization and long-term memory with expiry.',
    deps: ['ai-sdk', 'errors', 'logging', 'shared-types'],
  },
  {
    name: 'conversation',
    description: 'Conversation state: turns, summarisation and context-window fitting.',
    deps: ['ai-sdk', 'agent-memory', 'errors', 'model-registry', 'shared-types', 'token-meter'],
  },
  {
    name: 'agent-framework',
    description: 'Agent definitions: role, prompt, tools, permissions, limits, output schema.',
    deps: [
      'ai-policy',
      'ai-sdk',
      'errors',
      'function-calling',
      'model-registry',
      'prompt-registry',
      'shared-types',
      'tool-execution',
    ],
  },
  {
    name: 'agent-runtime',
    description: 'Runs an agent: the tool loop, streaming, stop conditions, execution history.',
    deps: [
      'agent-framework',
      'agent-memory',
      'ai-gateway',
      'ai-policy',
      'ai-sdk',
      'audit',
      'conversation',
      'errors',
      'function-calling',
      'guardrails',
      'logging',
      'observability',
      'shared-types',
      'tool-execution',
    ],
    nest: true,
  },
  {
    name: 'human-review',
    description: 'Review queues for AI output: approve, reject, escalate, with SLA and history.',
    deps: ['ai-sdk', 'audit', 'errors', 'logging', 'shared-types'],
  },
  {
    name: 'evaluation',
    description: 'Scoring AI output: groundedness, schema compliance, safety, cost and latency.',
    deps: ['ai-sdk', 'errors', 'logging', 'rag', 'shared-types'],
  },
  {
    name: 'ai-observability',
    description: 'The AI dashboard: requests, latency, tokens, cost, cache and agent usage.',
    deps: ['ai-sdk', 'cost-monitor', 'errors', 'observability', 'shared-types'],
  },
  {
    name: 'ai-workflows',
    description: 'Wiring AI results into phase 5 workflows and phase 6 events.',
    deps: ['ai-sdk', 'errors', 'event-sdk', 'human-review', 'logging', 'shared-types'],
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

/** Packages that do not use zod. Everything else validates something. */
const NO_ZOD = new Set();

function packageJson(entry) {
  const dependencies = Object.fromEntries(
    entry.deps
      .map((dep) => [`@trustos/${dep}`, '0.1.0'])
      .concat(NO_ZOD.has(entry.name) ? [] : [['zod', '^3.24.1']])
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
      references: entry.deps.map((dep) => ({ path: `../${dep}` })).sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  )}\n`;
}

let created = 0;

for (const entry of PACKAGES) {
  const base = join(root, 'packages', entry.name);
  mkdirSync(join(base, 'src'), { recursive: true });

  // package.json and tsconfig are always rewritten: they are the dependency declaration, and a
  // stale one is exactly the drift this script exists to prevent.
  writeFileSync(join(base, 'package.json'), packageJson(entry));
  writeFileSync(join(base, 'tsconfig.json'), tsconfig(entry));

  if (entry.nest) {
    mkdirSync(join(base, 'nest'), { recursive: true });
    writeFileSync(
      join(base, 'nest/package.json'),
      `${JSON.stringify(
        {
          '//': `Subpath stub: keeps NestJS bindings out of consumers that import '@trustos/${entry.name}'.`,
          name: `@trustos/${entry.name}-nest`,
          private: true,
          main: '../dist/nest/index.js',
          types: '../dist/nest/index.d.ts',
        },
        null,
        2,
      )}\n`,
    );
  }

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
// Without an alias, a test importing `@trustos/ai-sdk` resolves the built `dist` rather than the
// source — so a change is invisible to the test until a rebuild, which is exactly the feedback
// loop nobody notices is broken.

const vitestPath = join(root, 'vitest.config.ts');
let vitest = readFileSync(vitestPath, 'utf8');
const missing = PACKAGES.filter((entry) => !vitest.includes(`'@trustos/${entry.name}':`));

if (missing.length > 0) {
  const marker = "      '@trustos/integration-monitor': pkg('integration-monitor'),";
  if (!vitest.includes(marker)) {
    throw new Error(
      'Could not find the alias insertion point in vitest.config.ts. Update this script if the ' +
        'config was reorganised.',
    );
  }

  const additions = missing
    .map((entry) => `      '@trustos/${entry.name}': pkg('${entry.name}'),`)
    .join('\n');

  vitest = vitest.replace(marker, `${marker}\n\n      // Phase 7 — the AI platform.\n${additions}`);
  writeFileSync(vitestPath, vitest);
}

console.log(`${created} package(s) scaffolded.`);
console.log(`${missing.length} vitest alias(es) added.`);
console.log(`build graph: ${buildConfig.references.length} references.`);

if (!existsSync(join(root, 'packages/ai-sdk/src'))) {
  throw new Error('Scaffolding did not produce a source directory; something is wrong.');
}
