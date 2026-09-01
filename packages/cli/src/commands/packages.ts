import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MODULE_CATALOG } from '@trustsystem/module-registry';
import {
  applyPlan,
  emptyLockfile,
  outdated,
  parseLockfile,
  planInstall,
  planRemove,
  planUpdateAll,
  type AvailablePackage,
  type InstallPlan,
  type Lockfile,
} from '@trustsystem/package-manager';
import { describeExport, InMemoryTelemetrySink } from '@trustsystem/telemetry';
import type { Output } from '../output';
import { formatRows, style } from '../output';

/**
 * `trustos install`, `update`, `remove` and `telemetry review`.
 *
 * These *do* change things, unlike the rest of the platform commands — so they follow the rule the
 * phase is built on: **plan, show, then apply.** Every one prints what it would do and stops when
 * `--dry-run` is given, and `--dry-run` is not a separate path but the same plan, unapplied.
 *
 * What they change is the lockfile: what is recorded as installed, at which version, hashing to
 * what. Wiring the module into the composition root remains `trustos add-module`, which writes
 * code and is deliberately a different command with a different blast radius.
 */

export interface PackageCommandOptions {
  path?: string;
  json?: boolean;
  dryRun?: boolean;
  version?: string;
}

function findApplicationRoot(start: string): string | null {
  let current = start;

  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'trustos.json'))) return current;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

const LOCKFILE = 'trustos-lock.json';

/**
 * The catalogue, as installable packages.
 *
 * Built from `MODULE_CATALOG` — the local, reviewed catalogue. There is no remote source and no
 * flag to add one from the command line: a package source is a trust decision, and a trust
 * decision made by an argument is one nobody reviewed.
 */
function available(): AvailablePackage[] {
  return MODULE_CATALOG.map((entry) => ({
    id: entry.metadata.id,
    version: entry.metadata.version,
    // The framework ships verification, not signatures — see `trustos marketplace`. The digest is
    // over the declared surface, which is what a local catalogue can honestly attest to.
    integrity: digestOfEntry(entry.metadata.id, entry.metadata.version),
    signedBy: null,
    minimumFrameworkVersion: entry.metadata.minimumFrameworkVersion,
    dependencies: entry.dependencies.map((dependency) => ({
      moduleId: dependency.moduleId,
      versionRange: dependency.versionRange,
      optional: dependency.optional,
    })),
  }));
}

function digestOfEntry(id: string, version: string): string {
  return createHash('sha256').update(`${id}@${version}`).digest('hex');
}

async function readLockfile(root: string, frameworkVersion: string, now: Date): Promise<Lockfile> {
  const path = join(root, LOCKFILE);

  if (!existsSync(path)) return emptyLockfile(frameworkVersion, now);

  return parseLockfile(JSON.parse(await readFile(path, 'utf8')));
}

async function frameworkVersionOf(root: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'trustos.json'), 'utf8')) as {
      frameworkVersion?: string;
    };
    return manifest.frameworkVersion ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printPlan(plan: InstallPlan, output: Output): void {
  const changes = plan.steps.filter((step) => step.action !== 'unchanged');

  if (changes.length === 0) {
    output.info('  Nothing to change.');
    return;
  }

  output.info(
    formatRows(
      changes.map((step) => [
        `${step.action} ${step.id}`,
        `${step.fromVersion ? `${step.fromVersion} → ` : ''}${step.toVersion ?? 'removed'}  (${step.reason})`,
      ]),
      '  ',
    ),
  );
}

async function runPlan(
  plan: InstallPlan,
  options: PackageCommandOptions & { root: string; frameworkVersion: string; verb: string },
  output: Output,
): Promise<number> {
  if (options.json) {
    output.info(JSON.stringify(plan, null, 2));
    return plan.ok ? 0 : 1;
  }

  output.info(style.bold(`${options.verb} plan`));
  output.blank();
  printPlan(plan, output);
  output.blank();

  for (const warning of plan.warnings) output.warn(warning);

  if (!plan.ok) {
    for (const conflict of plan.conflicts) output.error(conflict);
    output.blank();
    output.error('Nothing has been changed.');
    return 1;
  }

  if (options.dryRun) {
    output.detail('  Nothing was changed. Re-run without --dry-run to apply.');
    return 0;
  }

  const now = new Date();
  const lockfile = await readLockfile(options.root, options.frameworkVersion, now);

  const result = applyPlan(plan, {
    lockfile,
    available: available(),
    frameworkVersion: options.frameworkVersion,
    now,
  });

  await writeFile(
    join(options.root, LOCKFILE),
    `${JSON.stringify(result.lockfile, null, 2)}\n`,
    'utf8',
  );

  output.success(`${result.applied.length} change(s) recorded in ${LOCKFILE}.`);
  output.detail('  Wire it into the application with `trustos add-module`.');

  return 0;
}

async function prepare(
  options: PackageCommandOptions,
  output: Output,
): Promise<{ root: string; frameworkVersion: string; lockfile: Lockfile } | null> {
  const root = options.path ?? findApplicationRoot(process.cwd());

  /*
   * `--path` is checked, not trusted. Without this, a path pointing at any directory was accepted
   * and the lockfile written into it — so a mistyped argument silently created a `trustos-lock.json`
   * somewhere that is not an application, and the real one stayed untouched.
   */
  if (!root || !existsSync(join(root, 'trustos.json'))) {
    output.error(
      root
        ? `No trustos.json in ${root}.`
        : 'No trustos.json found in this directory or any parent.',
    );
    output.detail('Run this inside a generated application, or point --path at one.');
    return null;
  }

  const frameworkVersion = await frameworkVersionOf(root);
  const lockfile = await readLockfile(root, frameworkVersion, new Date());

  return { root, frameworkVersion, lockfile };
}

/** `trustos install <module>`. */
export async function runInstall(
  moduleId: string,
  options: PackageCommandOptions,
  output: Output,
): Promise<number> {
  const context = await prepare(options, output);
  if (!context) return 1;

  const plan = planInstall(
    { id: moduleId, versionRange: options.version },
    {
      lockfile: context.lockfile,
      available: available(),
      frameworkVersion: context.frameworkVersion,
    },
  );

  return runPlan(plan, { ...options, ...context, verb: 'Install' }, output);
}

/** `trustos update [module]`. */
export async function runUpdate(
  moduleId: string | undefined,
  options: PackageCommandOptions,
  output: Output,
): Promise<number> {
  const context = await prepare(options, output);
  if (!context) return 1;

  const planOptions = {
    lockfile: context.lockfile,
    available: available(),
    frameworkVersion: context.frameworkVersion,
  };

  if (!moduleId) {
    const behind = outdated(context.lockfile, available());

    if (behind.length === 0 && !options.json) {
      output.success('Everything is on its newest compatible version.');
      return 0;
    }

    return runPlan(planUpdateAll(planOptions), { ...options, ...context, verb: 'Update' }, output);
  }

  const plan = planInstall(
    {
      id: moduleId,
      versionRange:
        options.version ??
        `^${context.lockfile.packages.find((entry) => entry.id === moduleId)?.version ?? '0.0.0'}`,
    },
    planOptions,
  );

  return runPlan(plan, { ...options, ...context, verb: 'Update' }, output);
}

/** `trustos remove <module>`. */
export async function runRemove(
  moduleId: string,
  options: PackageCommandOptions,
  output: Output,
): Promise<number> {
  const context = await prepare(options, output);
  if (!context) return 1;

  const plan = planRemove(moduleId, {
    lockfile: context.lockfile,
    available: available(),
    frameworkVersion: context.frameworkVersion,
  });

  return runPlan(plan, { ...options, ...context, verb: 'Remove' }, output);
}

/** `trustos outdated`. */
export async function runOutdated(options: PackageCommandOptions, output: Output): Promise<number> {
  const context = await prepare(options, output);
  if (!context) return 1;

  const behind = outdated(context.lockfile, available());

  if (options.json) {
    output.info(JSON.stringify(behind, null, 2));
    return 0;
  }

  if (behind.length === 0) {
    output.success('Everything is on its newest compatible version.');
    return 0;
  }

  output.info(style.bold(`${behind.length} module(s) behind`));
  output.blank();
  output.info(
    formatRows(
      behind.map((entry) => [entry.id, `${entry.current} → ${entry.latest}`]),
      '  ',
    ),
  );

  return 0;
}

/**
 * `trustos telemetry review`.
 *
 * Shows exactly what an export would contain. Nobody should have to read source to find out what a
 * framework would transmit — and since telemetry is local-first with no default destination, this
 * is also the only way to see it at all.
 */
export function runTelemetryReview(options: { json?: boolean }, output: Output): number {
  /*
   * Reads the in-process sink, which is empty in a fresh CLI run — and saying so plainly is the
   * point. A command that invented sample data here would misrepresent what the framework holds.
   */
  const sink = new InMemoryTelemetrySink();
  const summary = describeExport(sink.events);

  if (options.json) {
    output.info(JSON.stringify(summary, null, 2));
    return 0;
  }

  output.info(style.bold('Telemetry'));
  output.blank();

  if (summary.eventCount === 0) {
    output.info('  No events recorded in this process.');
    output.blank();
    output.detail('  Telemetry is off unless a deployment switches it on, and it has no default');
    output.detail('  destination — the framework ships no exporter and has no endpoint. Events');
    output.detail('  accumulate in a local sink and go nowhere until somebody wires one.');
    output.blank();
    output.detail('  An event carries a name, low-cardinality dimensions and numbers. There is no');
    output.detail('  free-text field, so there is nowhere for tenant data to land.');
    return 0;
  }

  output.info(
    formatRows(
      [
        ['events', String(summary.eventCount)],
        [
          'categories',
          Object.entries(summary.categories)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
        ],
        ['dimensions', summary.dimensionKeys.join(', ') || '—'],
        ['measurements', summary.measurementKeys.join(', ') || '—'],
      ],
      '  ',
    ),
  );

  output.blank();
  output.detail('  This is everything an export would contain. Nothing else is collected.');

  return 0;
}
