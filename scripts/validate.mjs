#!/usr/bin/env node
/**
 * `npm run validate` — what this framework can actually do, with the evidence.
 *
 *   npm run validate                 # inventory + tests, machine-readable summary
 *   npm run validate -- --deployed   # also probe a running deployment
 *   npm run validate -- --json       # JSON only, for CI
 *
 * Exits non-zero when a capability marked critical fails.
 *
 * The point is to refuse the easy answer. A capability is not implemented because a
 * package exists, a route is declared or a table is in the schema — this counts source
 * files, counts the tests that actually execute against them, and reports what it
 * found. A capability with code and no tests is reported as such rather than rounded up.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const probeDeployed = args.includes('--deployed');
const baseUrl = readFlag('--base-url') ?? process.env.TRUSTOS_BASE_URL ?? null;

function readFlag(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

/**
 * The capabilities this framework claims, and where each one lives.
 *
 * `critical` marks the ones whose failure means the framework is not usable at all:
 * a tenancy or authorization regression is not a degraded feature, it is a breach.
 */
const CAPABILITIES = [
  {
    id: 'identity',
    name: 'Identity',
    paths: ['packages/identity'],
    critical: true,
    classification: 'restricted',
    deployed: 'governance-tool',
  },
  { id: 'tenancy', name: 'Multi-tenancy', paths: ['packages/tenancy'], critical: true },
  { id: 'rbac', name: 'RBAC', paths: ['packages/rbac'], critical: true },
  { id: 'authorization', name: 'Authorization', paths: ['packages/authorization'], critical: true },
  { id: 'audit', name: 'Audit', paths: ['packages/audit'], critical: true },
  {
    id: 'workflow',
    name: 'Workflow',
    paths: [
      'packages/workflow-core',
      'packages/workflow-runtime',
      'packages/workflow-definition',
      'packages/workflow-tasks',
    ],
  },
  {
    id: 'maker-checker',
    name: 'Maker-checker',
    paths: ['packages/workflow-approvals', 'packages/workflow-policy'],
  },
  {
    id: 'policy',
    name: 'Policy engine',
    paths: ['packages/policy-engine', 'packages/policy-registry', 'packages/policy-evaluator'],
  },
  { id: 'case-management', name: 'Case management', paths: ['packages/case-management'] },
  {
    id: 'ai-gateway',
    name: 'AI gateway',
    paths: ['packages/ai-gateway', 'packages/ai-policy', 'packages/guardrails'],
  },
  {
    id: 'financial',
    name: 'Financial primitives',
    paths: ['packages/financial-core', 'packages/ledger', 'packages/wallet', 'packages/limits'],
    critical: true,
  },
  {
    id: 'financial-product',
    name: 'Financial product layer',
    paths: [
      'packages/financial-product-composer',
      'packages/financial-product-runtime',
      'packages/financial-product-simulator',
    ],
  },
  {
    id: 'api-management',
    name: 'API management',
    paths: [
      'packages/api-catalog',
      'packages/api-versioning',
      'packages/api-rate-limit',
      'packages/api-quota',
    ],
  },
  {
    id: 'data-governance',
    name: 'Data governance',
    paths: [
      'packages/data-classification',
      'packages/data-masking',
      'packages/data-access-policy',
      'packages/data-retention',
    ],
  },
  { id: 'observability', name: 'Observability', paths: ['packages/observability'] },
  {
    id: 'security',
    name: 'Security controls',
    paths: ['packages/session-security', 'packages/security-policy', 'packages/security-events'],
    critical: true,
  },
  { id: 'backup', name: 'Backup', paths: ['packages/backup'] },
  { id: 'restore', name: 'Restore', paths: ['packages/recovery'] },
  { id: 'governance-tool', name: 'Governance Tool', paths: ['packages/governance-tool-core'] },
  { id: 'cli', name: 'CLI and generator', paths: ['packages/cli', 'packages/generator-core'] },
];

function walk(directory, out = []) {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Source and spec counts, so "has code" and "has tests" stay separate answers. */
function inventory(paths) {
  let source = 0;
  let specs = 0;
  const files = [];

  for (const relative of paths) {
    for (const file of walk(join(root, relative))) {
      if (!file.endsWith('.ts')) continue;
      files.push(file);
      if (file.endsWith('.spec.ts')) specs += 1;
      else source += 1;
    }
  }

  return { source, specs, files };
}

/** Runs the suite once and returns per-file results, so nothing here is self-reported. */
function runTests() {
  const outputFile = join(root, 'node_modules', '.trustos-validate.json');
  mkdirSync(dirname(outputFile), { recursive: true });

  try {
    execFileSync('npx', ['vitest', 'run', '--reporter=json', '--outputFile', outputFile], {
      cwd: root,
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // A failing suite is a result, not a reason to stop: the report needs it.
  }

  if (!existsSync(outputFile)) return null;
  return JSON.parse(readFileSync(outputFile, 'utf8'));
}

function testsFor(report, paths) {
  if (!report?.testResults) return { total: 0, passed: 0, failed: 0, files: 0 };

  let total = 0;
  let passed = 0;
  let failed = 0;
  let files = 0;

  for (const suite of report.testResults) {
    const name = (suite.name ?? '').replace(`${root}/`, '');
    if (!paths.some((path) => name.startsWith(path))) continue;
    files += 1;
    for (const test of suite.assertionResults ?? []) {
      total += 1;
      if (test.status === 'passed') passed += 1;
      else if (test.status === 'failed') failed += 1;
    }
  }

  return { total, passed, failed, files };
}

/**
 * Classification, from counts rather than opinion.
 *
 * The distinction that matters is between code that is exercised and code that merely
 * exists. `STUB` is not an insult — it is the honest label for a package nothing tests,
 * and rounding it up to IMPLEMENTED is how a framework acquires a reputation it cannot
 * support.
 */
function classify({ source, specs }, tests) {
  if (source === 0) return 'NOT_IMPLEMENTED';
  if (tests.failed > 0) return 'BROKEN';
  if (specs === 0 || tests.total === 0) return 'STUB';
  if (tests.total < 10) return 'PARTIALLY_IMPLEMENTED';
  return 'IMPLEMENTED';
}

async function probe(url, path, headers = {}) {
  try {
    const response = await fetch(`${url}${path}`, { headers, redirect: 'manual' });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text.slice(0, 400) };
  } catch (error) {
    return { status: 0, error: error.message };
  }
}

/** Checks a running deployment answers, and answers safely. */
async function checkDeployment(url) {
  const results = [];

  const health = await probe(url, '/health');
  results.push({
    check: 'health',
    pass: health.status === 200,
    detail: `GET /health -> ${health.status}`,
  });

  const ready = await probe(url, '/ready');
  results.push({
    check: 'readiness',
    pass: ready.status === 200,
    detail: `GET /ready -> ${ready.status}`,
  });

  // A health endpoint that leaks configuration is worse than none.
  const leaks = ['password', 'secret', 'token', 'DATABASE_URL', 'jwt'];
  const leaked = leaks.filter((needle) =>
    health.body?.toLowerCase().includes(needle.toLowerCase()),
  );
  results.push({
    check: 'health-discloses-nothing',
    pass: leaked.length === 0,
    detail: leaked.length ? `discloses ${leaked.join(', ')}` : 'no credential-shaped keys',
  });

  const guarded = await probe(url, '/api/governance/apps');
  results.push({
    check: 'protected-route-refuses-anonymous',
    pass: guarded.status === 401 || guarded.status === 403,
    detail: `GET /api/governance/apps -> ${guarded.status}`,
  });

  const forged = await probe(url, '/api/governance/apps', { Authorization: 'Bearer not-a-token' });
  results.push({
    check: 'forged-token-refused',
    pass: forged.status === 401 || forged.status === 403,
    detail: `bearer "not-a-token" -> ${forged.status}`,
  });

  const headers = health.headers;
  for (const [name, header] of [
    ['hsts', 'strict-transport-security'],
    ['content-type-options', 'x-content-type-options'],
    ['frame-options', 'x-frame-options'],
    ['content-security-policy', 'content-security-policy'],
  ]) {
    results.push({
      check: `header-${name}`,
      pass: Boolean(headers?.get(header)),
      detail: headers?.get(header)?.slice(0, 60) ?? 'absent',
    });
  }

  // A wildcard CORS origin on an authenticated API is a finding, not a preference.
  const cors = await probe(url, '/health', { Origin: 'https://not-approved.example' });
  const allowed = cors.headers?.get('access-control-allow-origin');
  results.push({
    check: 'cors-refuses-unapproved-origin',
    pass: allowed !== '*' && allowed !== 'https://not-approved.example',
    detail: `Access-Control-Allow-Origin: ${allowed ?? 'absent'}`,
  });

  return results;
}

// --- run ---------------------------------------------------------------------

if (!wantJson) console.log('Running the test suite for evidence. This takes a minute.\n');
const report = runTests();

const capabilities = CAPABILITIES.map((capability) => {
  const counts = inventory(capability.paths);
  const tests = testsFor(report, capability.paths);
  return {
    id: capability.id,
    name: capability.name,
    critical: Boolean(capability.critical),
    sourceFiles: counts.source,
    specFiles: counts.specs,
    tests,
    status: classify(counts, tests),
  };
});

/*
 * The machine-readable registry.
 *
 * `status` is derived from what was measured, never declared: DRAFT for something with
 * no executing tests, IMPLEMENTED for code that is exercised, VALIDATED only where a
 * deployed service was probed as well. Nothing here can be set by editing a label.
 */
const registry = {
  generatedAt: new Date().toISOString(),
  frameworkVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  capabilities: capabilities.map((capability) => {
    const definition = CAPABILITIES.find((entry) => entry.id === capability.id);
    return {
      id: capability.id,
      name: capability.name,
      version: '0.1.0',
      owner: 'role:platform-engineering',
      status:
        capability.status === 'BROKEN'
          ? 'DISABLED'
          : capability.status === 'STUB' || capability.status === 'NOT_IMPLEMENTED'
            ? 'DRAFT'
            : 'IMPLEMENTED',
      securityClassification: definition?.classification ?? 'internal',
      dependencies: definition?.paths ?? [],
      interface: (definition?.paths ?? []).map((path) => `@trustos/${path.split('/').pop()}`),
      testCoverage: { tests: capability.tests.passed, specFiles: capability.specFiles },
      documentation: 'docs/validation/framework-current-state.md',
      deploymentRequirement: definition?.deployed ?? 'in-process library, no deployed service',
      critical: capability.critical,
    };
  }),
};

let deployment = null;
if (probeDeployed) {
  if (!baseUrl) {
    console.error('--deployed needs --base-url <url> or TRUSTOS_BASE_URL.');
    process.exit(2);
  }
  deployment = { baseUrl, checks: await checkDeployment(baseUrl) };
}

const failing = capabilities.filter((c) => c.status === 'BROKEN');
const criticalFailing = failing.filter((c) => c.critical);
const deploymentFailures = (deployment?.checks ?? []).filter((c) => !c.pass);

const summary = {
  generatedAt: new Date().toISOString(),
  totals: {
    tests: report?.numTotalTests ?? 0,
    passed: report?.numPassedTests ?? 0,
    failed: report?.numFailedTests ?? 0,
    suites: report?.numTotalTestSuites ?? 0,
  },
  capabilities,
  deployment,
  verdict:
    criticalFailing.length > 0 || (report?.numFailedTests ?? 0) > 0
      ? 'FAIL'
      : deploymentFailures.length > 0
        ? 'PARTIAL'
        : 'PASS',
};

if (wantJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `TrustOS validation — ${summary.totals.passed}/${summary.totals.tests} tests passing\n`,
  );
  const width = Math.max(...capabilities.map((c) => c.name.length));
  for (const capability of capabilities) {
    const mark = capability.critical ? '*' : ' ';
    console.log(
      `  ${mark} ${capability.name.padEnd(width)}  ${capability.status.padEnd(22)}` +
        `${String(capability.tests.passed).padStart(4)} tests  ` +
        `${capability.sourceFiles} src / ${capability.specFiles} spec`,
    );
  }
  console.log('\n  * = critical: a failure here is a breach, not a degraded feature\n');

  if (deployment) {
    console.log(`Deployment — ${deployment.baseUrl}`);
    for (const check of deployment.checks) {
      console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.check.padEnd(34)} ${check.detail}`);
    }
    console.log('');
  }

  console.log(`Verdict: ${summary.verdict}`);
}

/*
 * Written only when asked.
 *
 * A generated file that changes on every run leaves the working tree dirty after a
 * command whose whole job is to tell you the truth about the repository — and the first
 * thing it reports is a diff nobody made. `npm run evidence` already established the
 * pattern here: artefacts are regenerated deliberately, not as a side effect.
 */
if (args.includes('--write') || process.env.TRUSTOS_WRITE_EVIDENCE === '1') {
  writeFileSync(join(root, 'docs/validation/latest.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(
    join(root, 'docs/validation/capability-registry.json'),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  if (!wantJson) console.log('\nWrote docs/validation/latest.json and capability-registry.json');
}

if (summary.verdict === 'FAIL') process.exit(1);
