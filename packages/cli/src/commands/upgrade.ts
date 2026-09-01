import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MODULE_CATALOG } from '@trustsystem/module-registry';
import { migrationSchema, type Migration } from '@trustsystem/migration-tools';
import { ReleaseManager } from '@trustsystem/release-manager';
import { VersionHistory } from '@trustsystem/version-manager';
import { planUpgrade, recommendTarget } from '@trustsystem/upgrade-manager';
import type { GraphModule } from '@trustsystem/dependency-analyzer';
import type { Output } from '../output';
import { formatRows, style } from '../output';

/**
 * `trustos upgrade`.
 *
 * **It plans. It does not execute.** That is not a gap left for later — it is the decision the
 * phase is built around, and the previous placeholder said the same thing more bluntly: an
 * automated upgrade that silently rewrites security-relevant wiring is worse than a documented
 * manual one.
 *
 * What has changed is that the manual upgrade is no longer undocumented guesswork. This command
 * produces the *whole* plan — which migrations run, which are destructive, whether a backup is
 * mandatory, what would break, what recovery would look like — and refuses when the plan says it
 * should not proceed. An operator then applies it through whatever change control they already
 * have, with `@trustsystem/upgrade-manager`'s `executeUpgrade` if they want it automated.
 *
 * The reason to stop here rather than run it: the actions in an upgrade are the ones where a
 * mistake is expensive and irreversible, and a CLI that performs them is a CLI somebody runs in
 * the wrong terminal.
 */

export interface UpgradeOptions {
  path?: string;
  to?: string;
  json?: boolean;
  /** Where the release register and migration list live. Defaults to `.trustos/`. */
  registryDir?: string;
}

interface ProjectManifest {
  frameworkVersion?: string;
  modules?: Array<{ id: string; version?: string }>;
  appliedMigrations?: string[];
  backup?: { id: string; takenAt: string; includes: string[]; location: string } | null;
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

/** Reads an optional JSON file, returning null rather than throwing when it is absent. */
async function readOptional<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function runUpgrade(options: UpgradeOptions, output: Output): Promise<number> {
  const root = options.path ?? findApplicationRoot(process.cwd());

  if (!root) {
    output.error('No trustos.json found in this directory or any parent.');
    output.detail('Run this inside a generated application, or pass --path.');
    return 1;
  }

  const manifest = (await readOptional<ProjectManifest>(join(root, 'trustos.json'))) ?? {};
  const from = manifest.frameworkVersion;

  if (!from) {
    output.error('trustos.json does not record which framework version this project is on.');
    output.detail('Without it there is nothing to upgrade *from*, and a guess would be a plan.');
    return 1;
  }

  const registryDir = options.registryDir ?? join(root, '.trustos');

  const releases = new ReleaseManager(
    (await readOptional<unknown[]>(join(registryDir, 'releases.json'))) ?? [],
  );

  const history = new VersionHistory(
    (await readOptional<unknown[]>(join(registryDir, 'history.json'))) ?? [],
  );

  const migrations = (
    (await readOptional<unknown[]>(join(registryDir, 'migrations.json'))) ?? []
  ).map((entry) => migrationSchema.parse(entry)) as Migration[];

  if (releases.all().length === 0) {
    output.warn(`No release register at ${join(registryDir, 'releases.json')}.`);
    output.detail(
      '  Without one, every version is treated as unsupported and no target can be validated.',
    );
    output.detail('  See docs/release-process.md.');
    output.blank();
  }

  const target = options.to ?? recommendTarget({ current: from, releases }).to;

  if (!target) {
    output.success(`Already on ${from}; nothing newer is registered.`);
    return 0;
  }

  const modules: GraphModule[] = (manifest.modules ?? []).map((entry) => {
    const catalog = MODULE_CATALOG.find((candidate) => candidate.metadata.id === entry.id);

    return {
      id: entry.id,
      version: entry.version ?? catalog?.metadata.version ?? '0.0.0',
      dependencies:
        catalog?.dependencies.map((dependency) => ({
          moduleId: dependency.moduleId,
          versionRange: dependency.versionRange,
          optional: dependency.optional,
        })) ?? [],
    };
  });

  let plan;

  try {
    plan = planUpgrade({
      fromVersion: from,
      toVersion: target,
      modules,
      migrations,
      appliedMigrations: manifest.appliedMigrations,
      backup: manifest.backup ?? null,
      compatibility: {
        modules: (manifest.modules ?? []).map((entry) => {
          const catalog = MODULE_CATALOG.find((candidate) => candidate.metadata.id === entry.id);

          return {
            id: entry.id,
            version: entry.version ?? catalog?.metadata.version ?? '0.0.0',
            minimumFrameworkVersion: catalog?.metadata.minimumFrameworkVersion ?? '0.0.0',
          };
        }),
      },
      releases,
      history,
    });
  } catch (error) {
    // A downgrade is refused before any plan exists. Report it as the refusal it is.
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (options.json) {
    output.info(JSON.stringify(plan, null, 2));
    return plan.canProceed ? 0 : 1;
  }

  output.info(style.bold(`Upgrade ${plan.fromVersion} → ${plan.toVersion}`));
  output.blank();
  output.info(`  ${plan.summary}`);
  output.blank();

  const notable = plan.preflight.filter((finding) => finding.severity !== 'ok');

  if (notable.length > 0) {
    output.info(style.bold('Preflight'));
    output.blank();

    for (const finding of notable) {
      output.info(
        `  ${finding.severity === 'error' ? style.bold('FAIL') : 'WARN'}  ` +
          `${finding.check.padEnd(28)} ${finding.detail}`,
      );

      if (finding.remediation) output.detail(`        → ${finding.remediation}`);
    }

    output.blank();
  }

  if (plan.breakingChanges.length > 0) {
    output.info(style.bold('Breaking changes crossed'));
    output.blank();

    for (const change of plan.breakingChanges) {
      output.info(`  ${change.version}  ${change.change}`);
    }

    output.blank();
  }

  const pending = plan.migrations.steps.filter((step) => step.status === 'pending');

  if (pending.length > 0) {
    output.info(style.bold(`${pending.length} migration(s) would run`));
    output.blank();

    output.info(
      formatRows(
        pending.map((step) => [
          `${step.migration.id} (${step.migration.kind})`,
          step.migration.destructive
            ? `${step.migration.description} — DESTRUCTIVE`
            : step.migration.description,
        ]),
        '  ',
      ),
    );

    output.blank();
  }

  output.info(style.bold('If it fails'));
  output.detail(
    `  ${
      plan.rollback.strategy === 'reverse'
        ? 'Every step is reversible; they would be undone newest first.'
        : plan.rollback.strategy === 'restore'
          ? 'Irreversible steps are involved. Recovery means restoring the backup — migrations run ' +
            'forward, and a schema does not un-migrate.'
          : 'Nothing to undo.'
    }`,
  );
  output.blank();

  if (!plan.canProceed) {
    output.error(
      `${plan.preflight.filter((finding) => finding.severity === 'error').length} blocking ` +
        'problem(s). Nothing has been touched.',
    );
    return 1;
  }

  /*
   * Deliberately stops here. See the header: the actions in an upgrade are the ones where a
   * mistake is expensive, and a CLI that performs them is a CLI somebody runs in the wrong
   * terminal.
   */
  output.success('The plan is safe to run.');
  output.blank();
  output.detail('  This command plans; it does not execute. To apply it:');
  output.detail(
    '    • wire an UpgradeExecutor and call executeUpgrade from @trustsystem/upgrade-manager, or',
  );
  output.detail('    • run the migrations above through your own change control.');
  output.detail('  Either way, keep the report — it is what a change record wants.');
  output.detail('  See docs/upgrade-guide.md.');

  return 0;
}
