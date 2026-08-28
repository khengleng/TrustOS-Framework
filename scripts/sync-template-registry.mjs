#!/usr/bin/env node
/**
 * Writes the industry manifests into `packages/template-registry/src/industry.ts`.
 *
 * The manifests are derived from the same `template-specs.mjs` the file trees are, which is the
 * only arrangement where a template's declared entities and its actual models cannot disagree. A
 * hand-maintained registry beside a generated tree drifts within one change, and the drift is
 * silent: `trustos templates` keeps listing an entity nobody generates.
 *
 * Run it after editing `template-specs.mjs`. `sync-template-registry.spec.ts` fails the build if
 * you forget.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_SPECS } from './template-specs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'packages/template-registry/src/industry.ts');

/** Kept in step with `BASE_MODULES` and `TENANT_MODULES` in registry.ts. */
const BASE = ['config', 'database', 'errors', 'logging', 'validation', 'observability'];
const TENANT = ['auth', 'rbac', 'tenancy', 'audit'];

/** Prerequisites, mirroring MODULE_DEPENDENCIES in schema.ts so the emitted list is closed. */
const DEPENDENCIES = {
  ledger: ['financial-core'],
  accounts: ['financial-core', 'ledger'],
  wallet: ['financial-core', 'ledger', 'accounts'],
  transactions: ['financial-core'],
  payments: ['financial-core', 'transactions'],
  fees: ['financial-core'],
  limits: ['financial-core'],
  settlement: ['financial-core', 'ledger', 'accounts'],
  reconciliation: ['financial-core'],
  fx: ['financial-core'],
  'financial-reporting': ['financial-core'],
  'financial-risk': ['financial-core'],
  'financial-policy': ['financial-core'],
  'financial-events': ['financial-core'],
  'webhook-runtime': ['webhooks'],
  'workflow-runtime': ['workflow-core', 'workflow-definition'],
  'workflow-approvals': ['workflow-core'],
  'workflow-tasks': ['workflow-core'],
  'workflow-sla': ['workflow-core'],
  'workflow-escalation': ['workflow-core'],
  'workflow-history': ['workflow-core'],
  'workflow-policy': ['workflow-core', 'authorization'],
  'case-management': ['workflow-core'],
};

/** Adds every prerequisite until the set is closed. */
function close(modules) {
  const result = new Set(modules);
  let changed = true;

  while (changed) {
    changed = false;
    for (const module of [...result]) {
      for (const dependency of DEPENDENCIES[module] ?? []) {
        if (!result.has(dependency)) {
          result.add(dependency);
          changed = true;
        }
      }
    }
  }

  return [...result];
}

const chainOf = (spec) => {
  const byId = new Map(TEMPLATE_SPECS.map((entry) => [entry.id, entry]));
  const chain = [];
  let current = spec;

  while (current) {
    chain.unshift(current);
    current = current.extends ? byId.get(current.extends) : undefined;
  }

  return chain;
};

/**
 * Entities the template ends up with, its own last.
 *
 * A child's manifest lists its parents' entities too, because a developer choosing `hospital`
 * gets patients — and a manifest that only listed wards would make them think it did not.
 */
function entitiesOf(spec) {
  const own = chainOf(spec).flatMap((member) => (member.entities ?? []).map((entity) => entity.name));

  // `merchant` is hand-written and outside the spec file; its entities are named here so a
  // template extending it still advertises them.
  if (chainOf(spec)[0].extends === 'merchant' || spec.extends === 'merchant') {
    return ['Merchant', 'Store', 'Branch', 'MerchantMember', ...own];
  }

  return own;
}

/** Everything a parent contributed plus this template's own. */
function modulesOf(spec) {
  const inherited = chainOf(spec).flatMap((member) => member.modules ?? []);
  return close([...BASE, ...TENANT, ...inherited]).sort();
}

const quote = (value) => JSON.stringify(value);

function manifestFor(spec) {
  const lines = [];
  const apps = spec.apps ?? ['api', 'admin'];

  lines.push('  {');
  lines.push(`    id: ${quote(spec.id)},`);
  lines.push(`    displayName: ${quote(spec.displayName)},`);
  lines.push(`    description:`);
  for (const chunk of chunked(spec.description, 92)) lines.push(`      ${quote(chunk)} +`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ \+$/, ',');
  lines.push(`    version: '0.1.0',`);
  lines.push(`    category: ${quote(spec.category)},`);
  lines.push(`    status: ${quote(spec.status)},`);
  if (spec.extends) lines.push(`    extends: ${quote(spec.extends)},`);
  lines.push(`    minimumFrameworkVersion: '0.1.0',`);
  lines.push(`    documentation: 'docs/industry-reference.md',`);
  lines.push(`    includedApps: [${apps.map(quote).join(', ')}],`);
  lines.push('    includedModules: [');
  for (const module of modulesOf(spec)) lines.push(`      ${quote(module)},`);
  lines.push('    ],');
  lines.push('    requiredVariables: COMMON_VARIABLES,');
  lines.push(`    deploymentTargets: ['railway', 'local'],`);
  lines.push('    entities: [');
  for (const entity of entitiesOf(spec)) lines.push(`      ${quote(entity)},`);
  lines.push('    ],');
  lines.push('    migrationNotes:');
  for (const chunk of chunked(spec.migrationNotes, 92)) lines.push(`      ${quote(chunk)} +`);
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ \+$/, ',');
  lines.push(`    owner: ${quote(spec.owner)},`);
  lines.push('    outOfScope: [');
  for (const item of spec.outOfScope) lines.push(`      ${quote(item)},`);
  lines.push('    ],');
  lines.push('  },');

  return lines.join('\n');
}

/** Splits prose into quotable chunks on word boundaries, keeping a trailing space. */
function chunked(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const chunks = [];
  let line = '';

  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      chunks.push(`${line} `);
      line = word;
    }
  }

  if (line.length > 0) chunks.push(line);
  return chunks.length > 0 ? chunks : [''];
}

const header = `import type { TemplateManifest, TemplateVariable } from './schema';

/**
 * The industry templates.
 *
 * Generated by \`scripts/sync-template-registry.mjs\` from \`scripts/template-specs.mjs\`, which is
 * also what generates the file trees under \`templates/\`. Do not edit this file — edit the spec
 * and re-run the script.
 *
 * Deriving both from one source is the only arrangement where a manifest's \`entities\` and the
 * models a template actually writes cannot disagree. Maintained by hand, they drift on the first
 * change, and the drift is silent: \`trustos templates\` keeps advertising an entity nobody
 * generates, and somebody picks the template because of it.
 *
 * \`includedModules\` is closed under its own prerequisites here, so a template declaring
 * \`wallet\` also declares \`ledger\`, \`accounts\` and \`financial-core\`. The manifest schema
 * refuses one that is not.
 */
export function industryManifests(COMMON_VARIABLES: TemplateVariable[]): TemplateManifest[] {
  return [
`;

const footer = `  ] as TemplateManifest[];
}
`;

const body = TEMPLATE_SPECS.map(manifestFor).join('\n');

await writeFile(target, `${header}${body}\n${footer}`, 'utf8');

process.stdout.write(`Wrote ${TEMPLATE_SPECS.length} industry manifests to ${target}.\n`);
