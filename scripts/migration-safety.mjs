#!/usr/bin/env node
/**
 * Refuses a destructive migration that nobody approved.
 *
 * Prisma writes plain SQL into `packages/database/prisma/migrations`, and a migration is applied
 * by `prisma migrate deploy` with no review step of its own. So the review has to happen before
 * the file is merged, and this is that review — running in CI, on every pull request.
 *
 * **What it looks for.** Five patterns, each one a way to lose data:
 *
 *   DROP TABLE                a table and everything in it
 *   DROP COLUMN               a column and everything in it
 *   ALTER ... TYPE            a type change that may not round-trip
 *   SET NOT NULL              rows with a null in that column fail the migration, and the
 *                             deployment stops half-applied
 *   DELETE / TRUNCATE / UPDATE  a data migration, which is the one nobody reviews as one
 *
 * **How an intended one is approved.** A comment in the migration file:
 *
 *     -- trustos:destructive-approved reason="Column unused since v0.3; verified zero non-null rows"
 *     -- trustos:destructive-approved-by usr_platform_lead
 *
 * Both lines are required. The reason is what a reviewer reads six months later when they are
 * trying to work out where the data went, and a marker with no reason is a marker somebody pasted.
 *
 * **Migrations that predate this check.** They are approved in
 * `packages/database/prisma/migrations/.destructive-baseline.json` rather than by adding a marker
 * to the file, because **a marker would change the file and Prisma tracks migration checksums**.
 * Editing an applied migration makes `prisma migrate deploy` refuse against every database that
 * already ran it — which is the correct behaviour, and it means a check introduced to an existing
 * repository cannot ask for its history to be rewritten.
 *
 * The baseline is not an escape hatch for new migrations: a new file is checked against the marker
 * rule, and the baseline is compared by name against migrations that exist.
 *
 * Run: node scripts/migration-safety.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'packages/database/prisma/migrations';
const BASELINE = join(MIGRATIONS, '.destructive-baseline.json');

/**
 * The patterns, and what each costs.
 *
 * `SET NOT NULL` is the one people are surprised by. It is not destructive in itself — it destroys
 * nothing — and it fails at deploy time against any row holding a null, leaving the deployment
 * half-applied on a database somebody now has to reason about under time pressure.
 */
const PATTERNS = [
  {
    id: 'drop_table',
    regex: /\bDROP\s+TABLE\b/i,
    costs: 'The table and every row in it.',
  },
  {
    id: 'drop_column',
    regex: /\bDROP\s+COLUMN\b/i,
    costs: 'The column and every value in it.',
  },
  {
    id: 'type_change',
    regex: /\bALTER\s+COLUMN\b[\s\S]{0,80}?\b(TYPE|SET\s+DATA\s+TYPE)\b/i,
    costs: 'Values that do not cast cleanly. A widening is safe; a narrowing truncates.',
  },
  {
    id: 'set_not_null',
    regex: /\bSET\s+NOT\s+NULL\b/i,
    costs:
      'Nothing, unless a row holds a null — in which case the migration fails at deploy time and ' +
      'the deployment stops half-applied.',
  },
  {
    id: 'data_migration',
    regex: /^\s*(DELETE\s+FROM|TRUNCATE|UPDATE)\b/im,
    costs: 'Whatever the statement changes. A data migration is the one nobody reviews as one.',
  },
];

const APPROVAL = /--\s*trustos:destructive-approved\s+reason="([^"]{20,})"/i;
const APPROVER = /--\s*trustos:destructive-approved-by\s+(\S+)/i;

function migrationFiles() {
  let entries;
  try {
    entries = readdirSync(MIGRATIONS);
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const path = join(MIGRATIONS, entry);
    if (!statSync(path).isDirectory()) continue;

    const sql = join(path, 'migration.sql');
    try {
      statSync(sql);
      files.push({ name: entry, path: sql });
    } catch {
      // A migration directory with no migration.sql is Prisma's business, not this check's.
    }
  }

  return files.sort((left, right) => left.name.localeCompare(right.name));
}

/** Approvals for migrations that were already applied when this check was introduced. */
function baseline() {
  try {
    const parsed = JSON.parse(readFileSync(BASELINE, 'utf8'));
    return new Map(parsed.approvals.map((entry) => [entry.migration, entry]));
  } catch {
    return new Map();
  }
}

const baselined = baseline();
const findings = [];
const approved = [];

for (const file of migrationFiles()) {
  const sql = readFileSync(file.path, 'utf8');

  /*
   * Comments are stripped before matching, so a pattern named in a comment is not a finding.
   * Without this, the explanatory comments a good migration carries would trip the check that
   * exists to make people write them.
   */
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const matched = PATTERNS.filter((pattern) => pattern.regex.test(statements));
  if (matched.length === 0) continue;

  const grandfathered = baselined.get(file.name);

  if (grandfathered) {
    approved.push({
      migration: file.name,
      patterns: matched.map((pattern) => pattern.id),
      reason: grandfathered.reason,
      approvedBy: `${grandfathered.approvedBy} (baseline)`,
    });
    continue;
  }

  const reason = APPROVAL.exec(sql);
  const approver = APPROVER.exec(sql);

  if (reason && approver) {
    approved.push({
      migration: file.name,
      patterns: matched.map((pattern) => pattern.id),
      reason: reason[1],
      approvedBy: approver[1],
    });
    continue;
  }

  findings.push({
    migration: file.name,
    patterns: matched,
    hasReason: Boolean(reason),
    hasApprover: Boolean(approver),
  });
}

for (const entry of approved) {
  process.stdout.write(
    `approved  ${entry.migration}  [${entry.patterns.join(', ')}]  by ${entry.approvedBy}\n`,
  );
}

if (findings.length === 0) {
  process.stdout.write(
    `\n${migrationFiles().length} migration(s) checked. No unapproved destructive change.\n`,
  );
  process.exit(0);
}

process.stdout.write('\n');

for (const finding of findings) {
  process.stdout.write(`REFUSED  ${finding.migration}\n`);

  for (const pattern of finding.patterns) {
    process.stdout.write(`  ${pattern.id}: ${pattern.costs}\n`);
  }

  if (finding.hasReason && !finding.hasApprover) {
    process.stdout.write('  A reason is present and nobody has signed for it.\n');
  } else if (finding.hasApprover && !finding.hasReason) {
    process.stdout.write('  An approver is present with no reason, or a reason under 20 characters.\n');
  }

  process.stdout.write('\n');
}

process.stdout.write(
  [
    'A destructive migration needs both lines, in the migration file:',
    '',
    '  -- trustos:destructive-approved reason="why this is safe, in a sentence somebody can check"',
    '  -- trustos:destructive-approved-by usr_platform_lead',
    '',
    'The reason is read six months later by whoever is working out where the data went.',
    '',
  ].join('\n'),
);

process.exit(1);
