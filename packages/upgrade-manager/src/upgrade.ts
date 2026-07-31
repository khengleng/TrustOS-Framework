import { ApiError } from '@trustos/errors';
import {
  checkCompatibility,
  type CompatibilityInput,
  type CompatibilityReport,
} from '@trustos/compatibility-engine';
import {
  analyzeDependencies,
  type AnalysisReport,
  type GraphModule,
} from '@trustos/dependency-analyzer';
import {
  assertBackupTaken,
  describePlan,
  planMigrations,
  planRollback,
  type Migration,
  type MigrationPlan,
  type RollbackPlan,
} from '@trustos/migration-tools';
import { ReleaseManager } from '@trustos/release-manager';
import {
  assertForwardUpgrade,
  recommendUpgrade,
  VersionHistory,
  type UpgradeRecommendation,
} from '@trustos/version-manager';

/**
 * The upgrade.
 *
 * Everything else in Phase 10 exists so this can be a *plan* rather than a leap. The upgrade
 * manager runs the preflight, assembles the plan, and refuses to start when the plan says it
 * should not — and it stops there. It does not execute migrations, take backups or write files:
 * those are ports the caller supplies.
 *
 * The reason for that split is the thing this package is really about. An upgrade tool that both
 * decides and acts has one code path for "what would happen" and another for "what happened", and
 * the dry run stops predicting the real run the first time they diverge. Here there is one plan
 * object; `--dry-run` is printing it instead of handing it to an executor.
 *
 * The order of the preflight is the order in which failures are cheapest:
 *
 *   1. **Direction.** A downgrade is refused outright — migrations run forward.
 *   2. **Support.** Is the target actually released, and not withdrawn?
 *   3. **Compatibility.** Would the modules, database, CLI and templates still work?
 *   4. **Dependencies.** Does the module graph still resolve?
 *   5. **Migrations.** What would run, is any of it destructive, is there a backup?
 *
 * Steps 1–4 cost nothing and are checked before anything is touched. Step 5 is where the
 * mandatory backup lives, because that is the last moment it is still free.
 */

export type UpgradePhase = 'preflight' | 'backup' | 'migrate' | 'validate' | 'complete';

export interface Backup {
  id: string;
  takenAt: string;
  /** What it covers. A backup of the config that does not include the database is not a backup. */
  includes: string[];
  location: string;
}

export interface UpgradeRequest {
  fromVersion: string;
  toVersion: string;
  modules: readonly GraphModule[];
  migrations: readonly Migration[];
  appliedMigrations?: readonly string[];
  compatibility: Omit<CompatibilityInput, 'frameworkVersion'>;
  releases?: ReleaseManager;
  history?: VersionHistory;
  backup?: Backup | null;
  entryPoints?: readonly string[];
  now?: Date;
}

export interface PreflightFinding {
  check: string;
  severity: 'ok' | 'warning' | 'error';
  detail: string;
  remediation?: string;
}

export interface UpgradePlan {
  fromVersion: string;
  toVersion: string;
  preflight: PreflightFinding[];
  compatibility: CompatibilityReport;
  dependencies: AnalysisReport;
  migrations: MigrationPlan;
  rollback: RollbackPlan;
  recommendation: UpgradeRecommendation | null;
  breakingChanges: Array<{ version: string; change: string }>;
  /** False when anything in the preflight is an error. */
  canProceed: boolean;
  /** True when a backup is required and present. */
  backupRequired: boolean;
  summary: string;
}

export function planUpgrade(request: UpgradeRequest): UpgradePlan {
  const now = request.now ?? new Date();
  const preflight: PreflightFinding[] = [];

  // 1. Direction. Refused rather than reported: there is no plan for a downgrade.
  assertForwardUpgrade(request.fromVersion, request.toVersion);

  // 2. Support.
  preflight.push(...checkTargetRelease(request, now));

  // 3. Compatibility, evaluated against the *target* version — the question is whether things
  //    work after the upgrade, not whether they work now.
  const compatibility = checkCompatibility({
    ...request.compatibility,
    frameworkVersion: request.toVersion,
  });

  for (const finding of compatibility.findings) {
    if (finding.severity === 'ok') continue;

    preflight.push({
      check: `compatibility:${finding.surface}`,
      severity: finding.severity === 'error' ? 'error' : 'warning',
      detail: finding.detail,
      remediation: finding.remediation,
    });
  }

  // 4. Dependencies.
  const dependencies = analyzeDependencies({
    modules: request.modules,
    entryPoints: request.entryPoints,
  });

  for (const finding of dependencies.findings) {
    if (finding.severity === 'info') continue;

    preflight.push({
      check: `dependencies:${finding.kind}`,
      severity: finding.severity === 'error' ? 'error' : 'warning',
      detail: finding.detail,
      remediation: finding.remediation,
    });
  }

  // 5. Migrations.
  const migrations = planMigrations({
    migrations: request.migrations,
    fromVersion: request.fromVersion,
    toVersion: request.toVersion,
    applied: request.appliedMigrations,
  });

  for (const problem of migrations.problems) {
    preflight.push({ check: 'migrations', severity: 'error', detail: problem });
  }

  const backupRequired = migrations.destructive;

  if (backupRequired) {
    try {
      assertBackupTaken(migrations, request.backup ?? null);
      preflight.push({
        check: 'backup',
        severity: 'ok',
        detail: `Backup ${request.backup?.id} taken ${request.backup?.takenAt.slice(0, 10)}.`,
      });
    } catch (error) {
      preflight.push({
        check: 'backup',
        severity: 'error',
        detail: error instanceof Error ? error.message : String(error),
        remediation: 'Take a backup covering the database, then re-run.',
      });
    }
  }

  const breakingChanges =
    request.history?.breakingChangesBetween(request.fromVersion, request.toVersion) ?? [];

  if (breakingChanges.length > 0) {
    preflight.push({
      check: 'breaking-changes',
      severity: 'warning',
      detail: `${breakingChanges.length} breaking change(s) between ${request.fromVersion} and ${request.toVersion}.`,
      remediation: 'Each one needs a change on your side. The plan lists them.',
    });
  }

  const canProceed = !preflight.some((finding) => finding.severity === 'error');

  return {
    fromVersion: request.fromVersion,
    toVersion: request.toVersion,
    preflight,
    compatibility,
    dependencies,
    migrations,
    rollback: planRollback(migrations),
    recommendation: null,
    breakingChanges,
    canProceed,
    backupRequired,
    summary: summarize(request, migrations, preflight, canProceed),
  };
}

function checkTargetRelease(request: UpgradeRequest, now: Date): PreflightFinding[] {
  if (!request.releases) return [];

  const target = request.releases.find(request.toVersion);

  if (!target) {
    return [
      {
        check: 'release',
        severity: 'error',
        detail: `${request.toVersion} is not in the release register.`,
        remediation: 'Upgrade to a released version, or register the release first.',
      },
    ];
  }

  if (target.withdrawn) {
    return [
      {
        check: 'release',
        severity: 'error',
        detail: `${request.toVersion} was withdrawn: ${target.withdrawn}`,
        remediation: 'Pick a different target.',
      },
    ];
  }

  const findings: PreflightFinding[] = [
    {
      check: 'release',
      severity: 'ok',
      detail: `${request.toVersion} is on the ${target.channel} channel.`,
    },
  ];

  if (request.releases.isOutOfSupport(request.fromVersion, now)) {
    /*
     * Informational rather than blocking. Being out of support is the *reason* to upgrade — using
     * it to block the upgrade would trap exactly the deployments that most need to move.
     */
    findings.push({
      check: 'support',
      severity: 'warning',
      detail: `${request.fromVersion} is out of support. This upgrade is overdue rather than optional.`,
    });
  }

  return findings;
}

function summarize(
  request: UpgradeRequest,
  migrations: MigrationPlan,
  preflight: readonly PreflightFinding[],
  canProceed: boolean,
): string {
  const errors = preflight.filter((finding) => finding.severity === 'error').length;
  const warnings = preflight.filter((finding) => finding.severity === 'warning').length;

  if (!canProceed) {
    return `Cannot upgrade ${request.fromVersion} → ${request.toVersion}: ${errors} blocking problem(s).`;
  }

  return (
    `${request.fromVersion} → ${request.toVersion}. ${describePlan(migrations)}` +
    (warnings > 0 ? ` ${warnings} warning(s) to read first.` : '')
  );
}

/** What to upgrade to, given what is released and what is supported. */
export function recommendTarget(options: {
  current: string;
  releases: ReleaseManager;
  history?: VersionHistory;
  now?: Date;
  includePrereleases?: boolean;
}): UpgradeRecommendation {
  const now = options.now ?? new Date();

  return recommendUpgrade({
    current: options.current,
    available: options.releases
      .all()
      .filter((release) => !release.withdrawn)
      .map((release) => release.version),
    securityFixes: options.releases.securityReleases(),
    outOfSupport: options.releases.isOutOfSupport(options.current, now),
    includePrereleases: options.includePrereleases ?? false,
  });
}

export type ExecutionPhase = { phase: UpgradePhase; detail: string };

export interface UpgradeReport {
  plan: UpgradePlan;
  startedAt: string;
  finishedAt: string;
  phases: ExecutionPhase[];
  applied: string[];
  failed: { migrationId: string; error: string } | null;
  rolledBack: boolean;
  succeeded: boolean;
}

export interface UpgradeExecutor {
  backup(): Promise<Backup>;
  runMigration(migration: Migration): Promise<void>;
  reverseMigration(migration: Migration): Promise<void>;
  validate(): Promise<{ ok: boolean; detail: string }>;
  restore(backup: Backup): Promise<void>;
}

/**
 * Runs the plan.
 *
 * On failure, the recovery depends on what the plan said *before* it started — reverse when every
 * applied step was reversible, restore otherwise. Deciding that at failure time, with a
 * half-migrated database, is deciding it under the worst possible conditions.
 *
 * Refuses a plan that cannot proceed rather than trying and stopping partway.
 */
export async function executeUpgrade(
  plan: UpgradePlan,
  executor: UpgradeExecutor,
  options: { now: () => Date },
): Promise<UpgradeReport> {
  if (!plan.canProceed) {
    throw ApiError.conflict(
      `Refusing to execute: ${plan.preflight.filter((finding) => finding.severity === 'error').length} ` +
        'blocking problem(s) in the preflight.',
    );
  }

  const startedAt = options.now().toISOString();
  const phases: ExecutionPhase[] = [];
  const applied: string[] = [];
  let backup: Backup | null = null;
  let failed: UpgradeReport['failed'] = null;
  let rolledBack = false;

  /*
   * The migration that was running when it threw. It is *not* in `applied` — it did not finish —
   * but it may have partially applied, which is the case recovery must not treat as "nothing
   * happened".
   */
  let inFlight: string | null = null;

  phases.push({ phase: 'preflight', detail: plan.summary });

  try {
    if (plan.backupRequired) {
      backup = await executor.backup();
      phases.push({ phase: 'backup', detail: `Backup ${backup.id} at ${backup.location}.` });
    }

    for (const step of plan.migrations.steps) {
      if (step.status !== 'pending') continue;

      inFlight = step.migration.id;
      await executor.runMigration(step.migration);
      applied.push(step.migration.id);
      inFlight = null;
    }

    phases.push({ phase: 'migrate', detail: `${applied.length} migration(s) applied.` });

    const validation = await executor.validate();
    phases.push({ phase: 'validate', detail: validation.detail });

    if (!validation.ok) throw new Error(`Post-upgrade validation failed: ${validation.detail}`);

    phases.push({ phase: 'complete', detail: `Now on ${plan.toVersion}.` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failed = {
      migrationId: inFlight ?? applied[applied.length - 1] ?? 'preflight',
      error: message,
    };

    rolledBack = await recover(plan, executor, applied, inFlight, backup, phases);
  }

  return {
    plan,
    startedAt,
    finishedAt: options.now().toISOString(),
    phases,
    applied,
    failed,
    rolledBack,
    succeeded: failed === null,
  };
}

async function recover(
  plan: UpgradePlan,
  executor: UpgradeExecutor,
  applied: readonly string[],
  inFlight: string | null,
  backup: Backup | null,
  phases: ExecutionPhase[],
): Promise<boolean> {
  const appliedSteps = plan.migrations.steps.filter((step) => applied.includes(step.migration.id));

  /*
   * The migration that threw is the dangerous one. It is not in `applied` because it never
   * finished, but a database migration that failed halfway may already have dropped a column —
   * and treating "not recorded as applied" as "nothing happened" is how a recovery reports
   * success over a mangled schema.
   *
   * So a failure *inside* an irreversible migration means restore, even when nothing before it
   * needed one.
   */
  const inFlightStep = plan.migrations.steps.find((step) => step.migration.id === inFlight);
  const inFlightIsRecoverable = !inFlightStep || inFlightStep.migration.reversible;

  const allReversible =
    appliedSteps.every((step) => step.migration.reversible) && inFlightIsRecoverable;

  if (allReversible) {
    for (const step of [...appliedSteps].reverse()) {
      await executor.reverseMigration(step.migration);
    }

    phases.push({ phase: 'migrate', detail: `Reversed ${appliedSteps.length} migration(s).` });
    return true;
  }

  if (backup) {
    await executor.restore(backup);
    phases.push({ phase: 'backup', detail: `Restored from ${backup.id}.` });
    return true;
  }

  /*
   * Nothing to reverse to and nothing to restore from. Reported rather than hidden — a report
   * that says "rolled back" when nothing was is the worst possible output.
   */
  phases.push({
    phase: 'migrate',
    detail:
      'Could not roll back: irreversible migrations were applied and no backup exists. The system ' +
      'is between versions and needs manual recovery.',
  });

  return false;
}

/** A human-readable report. What gets pasted into the change record. */
export function renderReport(report: UpgradeReport): string {
  const lines: string[] = [];

  lines.push(`# Upgrade ${report.plan.fromVersion} → ${report.plan.toVersion}`);
  lines.push('');
  lines.push(report.succeeded ? '**Succeeded.**' : '**Failed.**');
  lines.push('');
  lines.push(`Started ${report.startedAt}, finished ${report.finishedAt}.`);
  lines.push('');

  if (report.plan.breakingChanges.length > 0) {
    lines.push('## Breaking changes crossed');
    lines.push('');
    for (const change of report.plan.breakingChanges) {
      lines.push(`- ${change.version}: ${change.change}`);
    }
    lines.push('');
  }

  lines.push('## What happened');
  lines.push('');
  for (const phase of report.phases) lines.push(`- **${phase.phase}** — ${phase.detail}`);
  lines.push('');

  if (report.failed) {
    lines.push('## Failure');
    lines.push('');
    lines.push(`Failed at \`${report.failed.migrationId}\`: ${report.failed.error}`);
    lines.push('');
    lines.push(
      report.rolledBack
        ? 'The system was rolled back and is on the version it started from.'
        : '**The system was not rolled back and is between versions.** Manual recovery is needed.',
    );
    lines.push('');
  }

  return lines.join('\n');
}
