#!/usr/bin/env node
/**
 * Regenerates the template copies of the framework Prisma schema.
 *
 * Prisma has no cross-package schema import, so a generated application carries its own copy
 * of the framework models. A hand-maintained copy drifts, and it drifts *silently*: a client
 * generated from a stale schema simply does not know a column, and the first symptom is a
 * runtime error rather than a build failure.
 *
 * That is not hypothetical. The base template's copy sat at 9 models while the framework had
 * 27 — so a generated application could not see `ApiKey`, `ServiceAccount`, `UserSession` or
 * `SecurityEvent`, and every phase-4 feature was unreachable from a generated app for two
 * phases without anybody noticing.
 *
 * So the copies are generated, and `schema-fragments.spec.ts` fails the build when they differ
 * from what this script would produce. Run it after changing the framework schema:
 *
 *   node scripts/sync-schema-fragments.mjs
 *
 * The split between fragments is by *audience*, not by phase:
 *
 *   _base                  identity, tenancy, RBAC, audit, sessions, credentials.
 *                          Every application needs these.
 *   workflow-enabled-saas  the workflow and case models. Only a template that governs a
 *                          business object with a workflow needs them, and carrying fourteen
 *                          unused tables into every generated application would be fourteen
 *                          tables somebody has to explain.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages/database/prisma/schema.prisma');

/**
 * Section markers in the framework schema.
 *
 * Matched on the banner comment rather than on line numbers, so inserting a model does not
 * silently move a boundary. A marker that stops matching is a loud failure here rather than a
 * fragment that quietly loses half its models.
 */
const PHASE_5_MARKER = '// Phase 5 — governed workflow, maker-checker and case management';
const PHASE_6_MARKER = '// Phase 6 — events, webhooks, jobs, schedules, providers, import/export, sync';

export function readSource() {
  return readFileSync(source, 'utf8');
}

function bannerStart(schema, marker, label) {
  const index = schema.indexOf(marker);
  if (index === -1) {
    throw new Error(
      `Could not find the "${label}" section marker in the framework schema. Section markers ` +
        'are how the fragments are split; update sync-schema-fragments.mjs if the schema was ' +
        'reorganised.',
    );
  }
  // Rewind to the `// ===` banner line that opens the section.
  return schema.lastIndexOf('// ===========================================================================', index);
}

/**
 * The generator block a generated application needs.
 *
 * The framework's own block has no `output`, so the client lands in
 * `node_modules/@prisma/client`. A generated application must not do that: the framework
 * packages are linked from a checkout that has its *own* client generated from the framework
 * schema alone, and sharing the default location makes which one wins a function of npm
 * hoisting — with the loser being a client that has never heard of the product's models.
 *
 * So the generator block is replaced rather than copied. The first version of this script
 * copied it verbatim and produced a generated application whose typecheck failed with
 * "cannot find module ../../../../prisma/generated/client", which is how this replacement
 * came to be here.
 */
const APPLICATION_GENERATOR = `generator client {
  provider = "prisma-client-js"
  // Generated into a directory this repository owns, rather than into
  // node_modules/@prisma/client.
  //
  // The framework packages are linked from a checkout that has its own
  // @prisma/client, generated from the framework schema alone. Sharing the
  // default location makes which one wins a function of npm hoisting, and the
  // loser is a client that has never heard of this product's models. An
  // explicit output path removes the ambiguity entirely.
  output   = "../generated/client"
}`;

/**
 * Everything an application always needs: phases 1, 4, 6, 7 and 8.
 *
 * The integration layer is in the base rather than in a template of its own, because events,
 * jobs, webhooks and schedules are infrastructure every application eventually wants — unlike
 * the workflow models, which only make sense for a product that governs a business object. The
 * phase 7 AI tables follow the same rule and for the same reason: `trustos add-module ai` should
 * be a wiring change rather than a migration, and an application that never enables AI carries
 * seventeen empty tables, which costs nothing. The phase 8 financial tables follow again: a
 * ledger is infrastructure, and `trustos add-module ledger` should not be a migration.
 *
 * That means the base is two slices of the framework schema with the workflow section cut out of
 * the middle, rather than a prefix. Worth stating, because the obvious `slice(0, marker)` is what
 * this used to be and it would now silently drop every integration table.
 *
 * Includes the datasource block and a *rewritten* generator block, because the fragment is the
 * only schema file a generated application has that declares either.
 */
export function baseFragment(schema) {
  const workflowStart = bannerStart(schema, PHASE_5_MARKER, 'phase 5');
  const integrationStart = bannerStart(schema, PHASE_6_MARKER, 'phase 6');

  if (integrationStart < workflowStart) {
    throw new Error(
      'The phase 6 section appears before the phase 5 section in the framework schema. The ' +
        'fragments are extracted by slicing between markers, so the order matters; update ' +
        'sync-schema-fragments.mjs if the schema was reorganised.',
    );
  }

  const models =
    schema.slice(0, workflowStart).trimEnd() +
    '\n\n' +
    schema.slice(integrationStart).trimEnd() +
    '\n';

  const generator = /generator client \{[\s\S]*?\n\}/.exec(models);
  if (!generator) {
    throw new Error(
      'Could not find the generator block in the framework schema. The base fragment has to ' +
        'rewrite it with an explicit output path; update sync-schema-fragments.mjs.',
    );
  }

  return models.replace(generator[0], APPLICATION_GENERATOR);
}

/** The workflow and case models, and only those — the integration section is in the base. */
export function workflowFragment(schema) {
  const workflowStart = bannerStart(schema, PHASE_5_MARKER, 'phase 5');
  const integrationStart = bannerStart(schema, PHASE_6_MARKER, 'phase 6');
  return schema.slice(workflowStart, integrationStart).trimEnd() + '\n';
}

const BASE_HEADER = `// =============================================================================
// Framework schema — TrustOS foundation models.
//
// GENERATED FROM @trustsystem/database by scripts/sync-schema-fragments.mjs.
// Do not edit by hand: schema-fragments.spec.ts fails the build when this file
// differs from what that script produces.
//
// Prisma has no cross-package schema import, so a generated application carries
// its own copy of the framework models. Regenerate after upgrading the
// framework:
//
//   node scripts/sync-schema-fragments.mjs
//
// Product models live beside this file in 10-product.prisma. Prisma loads every
// .prisma file in this directory, so the two compose without either one editing
// the other.
//
// Do not edit the models below to fit a product. Add product models instead.
// =============================================================================

`;

const WORKFLOW_HEADER = `// =============================================================================
// Workflow schema — TrustOS phase 5 models.
//
// GENERATED FROM @trustsystem/database by scripts/sync-schema-fragments.mjs.
// Do not edit by hand: schema-fragments.spec.ts fails the build when this file
// differs from what that script produces.
//
// Only templates that govern a business object with a workflow carry these.
// Regenerate after upgrading the framework:
//
//   node scripts/sync-schema-fragments.mjs
// =============================================================================

`;

export const FRAGMENTS = [
  {
    path: 'templates/_base/files/prisma/schema/00-framework.prisma',
    header: BASE_HEADER,
    extract: baseFragment,
  },
  {
    path: 'templates/workflow-enabled-saas/files/prisma/schema/05-workflow.prisma',
    header: WORKFLOW_HEADER,
    extract: workflowFragment,
  },
];

/** The exact bytes each fragment should contain. */
export function expectedFragments(schema = readSource()) {
  return FRAGMENTS.map((fragment) => ({
    path: fragment.path,
    content: fragment.header + fragment.extract(schema),
  }));
}

// Run directly, rather than imported by the test.
if (process.argv[1] && process.argv[1].endsWith('sync-schema-fragments.mjs')) {
  const schema = readSource();
  let changed = 0;

  for (const { path, content } of expectedFragments(schema)) {
    const absolute = join(root, path);
    const existing = (() => {
      try {
        return readFileSync(absolute, 'utf8');
      } catch {
        return null;
      }
    })();

    if (existing === content) {
      console.log(`unchanged  ${path}`);
      continue;
    }

    writeFileSync(absolute, content);
    const models = (content.match(/^model /gm) ?? []).length;
    console.log(`written    ${path}  (${models} models)`);
    changed += 1;
  }

  console.log(changed === 0 ? '\nEvery fragment is in sync.' : `\n${changed} fragment(s) updated.`);
}
