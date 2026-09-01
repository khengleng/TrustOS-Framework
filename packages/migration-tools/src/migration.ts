import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { compareVersions, isValidVersion } from '@trustsystem/version-manager';

/**
 * Migrations across every surface an upgrade touches.
 *
 * Five kinds, and they differ in one respect that governs everything else: **whether they can be
 * undone.**
 *
 *   * `config`, `template` and `module` migrations rewrite files. Reversible, because the
 *     previous file can be restored.
 *   * `database` migrations are not. A dropped column does not come back, and a backfill that
 *     merged two fields cannot be unmerged. The framework says so rather than offering a `down`
 *     that silently loses data.
 *   * `framework` migrations are a sequence of the others.
 *
 * So the rollback story is honest: **reversible migrations reverse; irreversible ones are
 * recovered from the backup taken before the upgrade started.** A `down` script that pretends to
 * undo a destructive change is worse than no `down` at all, because it is trusted.
 *
 * Everything here plans and validates. Execution is a port the caller supplies — this package
 * never opens a database connection or writes a file, which is what lets the dry run and the real
 * run take the same path.
 */

export const MIGRATION_KINDS = ['database', 'config', 'template', 'module', 'framework'] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

export const migrationSchema = z
  .object({
    id: z.string().regex(/^[0-9]{8,14}_[a-z][a-z0-9_]*$/, 'Must be <timestamp>_<snake_case_name>.'),
    kind: z.enum(MIGRATION_KINDS),
    description: z.string().min(1).max(300),
    /** The version this migration brings the system *to*. */
    targetVersion: z.string().refine(isValidVersion, 'Must be a semantic version.'),
    /**
     * Whether it can be undone by running something.
     *
     * Defaults to false, which is the safe default: a migration assumed reversible and then found
     * not to be is discovered during a rollback, which is the worst moment available.
     */
    reversible: z.boolean().default(false),
    /**
     * Whether it destroys data.
     *
     * Separate from `reversible` because they are different questions: adding a NOT NULL column
     * with a default is irreversible and destroys nothing, while a data backfill may be
     * reversible and still lose precision.
     */
    destructive: z.boolean().default(false),
    /** Migrations that must run first. */
    dependsOn: z.array(z.string()).default([]),
    /** Roughly how long, for an operator planning a maintenance window. */
    estimatedSeconds: z.number().int().min(0).default(0),
    /** What must be true before it runs. Checked in a dry run. */
    preconditions: z.array(z.string().min(1).max(200)).default([]),
  })
  .strict()
  .superRefine((migration, ctx) => {
    if (migration.reversible && migration.destructive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reversible'],
        message:
          'A destructive migration cannot be reversible. A dropped column does not come back, and ' +
          'a "down" script that claims otherwise is trusted and wrong.',
      });
    }

    if (migration.kind === 'database' && migration.reversible && migration.estimatedSeconds > 300) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reversible'],
        message:
          'A database migration taking more than five minutes should not be marked reversible: ' +
          'reversing it takes at least as long, during an incident.',
      });
    }
  });

export type Migration = z.infer<typeof migrationSchema>;

export type StepStatus = 'pending' | 'skipped' | 'applied' | 'failed';

export interface PlannedStep {
  migration: Migration;
  status: StepStatus;
  /** Why it would be skipped: already applied, or not needed for this range. */
  reason?: string;
}

export interface MigrationPlan {
  fromVersion: string;
  toVersion: string;
  steps: PlannedStep[];
  /** Preconditions the caller must satisfy before running. */
  preconditions: string[];
  /** True when any step destroys data. Governs whether a backup is mandatory. */
  destructive: boolean;
  /** True when every step can be reversed by running something. */
  fullyReversible: boolean;
  estimatedSeconds: number;
  problems: string[];
}

/**
 * Builds the plan.
 *
 * Ordered by dependency, then by id — so the same set of migrations produces the same order on
 * every machine. A migration order that depends on directory listing is one that differs between
 * a developer's laptop and CI, and the difference is discovered in production.
 */
export function planMigrations(options: {
  migrations: readonly Migration[];
  fromVersion: string;
  toVersion: string;
  /** Migration ids already applied. */
  applied?: readonly string[];
}): MigrationPlan {
  const applied = new Set(options.applied ?? []);
  const problems: string[] = [];

  const relevant = options.migrations.filter(
    (migration) =>
      compareVersions(migration.targetVersion, options.fromVersion) > 0 &&
      compareVersions(migration.targetVersion, options.toVersion) <= 0,
  );

  const byId = new Map(relevant.map((migration) => [migration.id, migration]));

  for (const migration of relevant) {
    for (const dependency of migration.dependsOn) {
      if (!byId.has(dependency) && !applied.has(dependency)) {
        problems.push(
          `${migration.id} depends on ${dependency}, which is neither applied nor in this range.`,
        );
      }
    }
  }

  const ordered = topologicalOrder(relevant, problems);

  const steps: PlannedStep[] = ordered.map((migration) => ({
    migration,
    status: applied.has(migration.id) ? 'skipped' : 'pending',
    reason: applied.has(migration.id) ? 'already applied' : undefined,
  }));

  const pending = steps.filter((step) => step.status === 'pending');

  return {
    fromVersion: options.fromVersion,
    toVersion: options.toVersion,
    steps,
    preconditions: [...new Set(pending.flatMap((step) => step.migration.preconditions))],
    destructive: pending.some((step) => step.migration.destructive),
    fullyReversible: pending.every((step) => step.migration.reversible),
    estimatedSeconds: pending.reduce((total, step) => total + step.migration.estimatedSeconds, 0),
    problems,
  };
}

function topologicalOrder(migrations: readonly Migration[], problems: string[]): Migration[] {
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  const ordered: Migration[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (migration: Migration, path: string[]): void => {
    const current = state.get(migration.id);
    if (current === 'done') return;

    if (current === 'visiting') {
      problems.push(`Migration cycle: ${[...path, migration.id].join(' → ')}.`);
      return;
    }

    state.set(migration.id, 'visiting');

    for (const dependency of [...migration.dependsOn].sort()) {
      const next = byId.get(dependency);
      if (next) visit(next, [...path, migration.id]);
    }

    state.set(migration.id, 'done');
    ordered.push(migration);
  };

  // Sorted by id first, so the traversal — and therefore the output — is deterministic.
  for (const migration of [...migrations].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    visit(migration, []);
  }

  return ordered;
}

/**
 * Refuses to run a destructive plan without a backup.
 *
 * Not a warning. The single most expensive failure in this phase is a destructive migration run
 * against a production database with nothing to restore from, and it happens because a warning
 * scrolled past.
 */
export function assertBackupTaken(plan: MigrationPlan, backup: { takenAt: string } | null): void {
  if (!plan.destructive) return;

  if (!backup) {
    throw ApiError.conflict(
      `This plan contains ${plan.steps.filter((step) => step.migration.destructive).length} ` +
        'destructive migration(s) and no backup has been recorded. Destructive migrations cannot ' +
        'be reversed — the only way back is a restore.',
    );
  }
}

/** What a rollback would actually do, per step. The honest answer, per the header. */
export interface RollbackPlan {
  reversible: PlannedStep[];
  /** Steps that can only be recovered from a backup. */
  requiresRestore: PlannedStep[];
  strategy: 'reverse' | 'restore' | 'none';
}

export function planRollback(plan: MigrationPlan): RollbackPlan {
  const appliedOrPending = plan.steps.filter((step) => step.status !== 'skipped');

  const reversible = appliedOrPending.filter((step) => step.migration.reversible);
  const requiresRestore = appliedOrPending.filter((step) => !step.migration.reversible);

  return {
    // Reverse order: the last migration applied is the first to undo.
    reversible: [...reversible].reverse(),
    requiresRestore,
    strategy:
      appliedOrPending.length === 0 ? 'none' : requiresRestore.length > 0 ? 'restore' : 'reverse',
  };
}

/** A summary an operator reads before a maintenance window. */
export function describePlan(plan: MigrationPlan): string {
  const pending = plan.steps.filter((step) => step.status === 'pending');

  if (pending.length === 0)
    return `Nothing to migrate between ${plan.fromVersion} and ${plan.toVersion}.`;

  const minutes = Math.ceil(plan.estimatedSeconds / 60);
  const byKind = new Map<MigrationKind, number>();

  for (const step of pending) {
    byKind.set(step.migration.kind, (byKind.get(step.migration.kind) ?? 0) + 1);
  }

  const breakdown = [...byKind.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ');

  return (
    `${pending.length} migration(s) (${breakdown}), roughly ${minutes} minute(s). ` +
    (plan.destructive
      ? 'Contains destructive changes — a backup is mandatory and rollback means restore.'
      : plan.fullyReversible
        ? 'Every step is reversible.'
        : 'Some steps cannot be reversed; rollback means restore.')
  );
}
