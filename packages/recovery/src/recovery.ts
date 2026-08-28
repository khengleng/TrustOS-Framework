import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { BACKUP_SOURCES, type BackupRecord, type BackupSource } from '@trustos/backup';

/**
 * Restore procedures, and restore *tests*.
 *
 * The distinction between the two words is the package. A restore *procedure* is a document. A
 * restore *test* is an event with a duration, a result and a report — and the specification is
 * explicit that one does not substitute for the other: *a backup that has never been successfully
 * restored must not be marked fully validated*.
 *
 * Three properties are enforced rather than encouraged:
 *
 * **A restore test runs somewhere isolated.** `targetEnvironment` cannot be production, because a
 * restore test that writes to production is not a test — it is an outage with a rehearsal
 * attached. This is the one refusal in the file that would be inconvenient to work around, which
 * is the point.
 *
 * **The duration is measured, not estimated.** An RTO derived from "the restore takes about an
 * hour" is a number nobody has checked, and the checking always finds it is longer: the index
 * rebuild nobody counted, the application that will not start until a migration runs.
 *
 * **The checks are individually recorded.** A restore that produced a database which starts but
 * whose ledger does not balance is not a successful restore, and a single pass/fail hides exactly
 * that.
 */

export const RESTORE_CHECKS = [
  'database_restored',
  'schema_matches',
  'row_counts_plausible',
  'referential_integrity',
  'application_starts',
  'health_check_passes',
  'ledger_balances',
  'audit_chain_intact',
  'sample_records_readable',
] as const;
export type RestoreCheck = (typeof RESTORE_CHECKS)[number];

/**
 * What each check establishes, and whether failing it invalidates the restore.
 *
 * `ledger_balances` and `audit_chain_intact` are non-negotiable for a financial platform: a
 * restored ledger that does not balance is corrupt data presented as a recovery, and the
 * corruption is discovered later by a reconciliation nobody connects to the restore.
 */
export const CHECK_MEANING: Record<
  RestoreCheck,
  { readonly establishes: string; readonly required: boolean }
> = {
  database_restored: { establishes: 'The dump loaded without error.', required: true },
  schema_matches: {
    establishes: 'The restored schema matches what the application expects at this version.',
    required: true,
  },
  row_counts_plausible: {
    establishes: 'Table row counts are within the expected range of the source at backup time.',
    required: true,
  },
  referential_integrity: {
    establishes: 'Foreign keys resolve; nothing references a row that did not come back.',
    required: true,
  },
  application_starts: {
    establishes: 'The application boots against the restored data.',
    required: true,
  },
  health_check_passes: {
    establishes: 'Readiness reports healthy against the restored data.',
    required: true,
  },
  ledger_balances: {
    establishes:
      'Every restored journal entry still balances, and the account balances derive from them. A restored ledger that does not balance is corrupt data presented as a recovery.',
    required: true,
  },
  audit_chain_intact: {
    establishes: 'The audit records restored are contiguous and unmodified.',
    required: true,
  },
  sample_records_readable: {
    establishes: 'A sample of business records reads correctly end to end.',
    required: false,
  },
};

export const recoveryProcedureSchema = z
  .object({
    procedureId: z.string().min(3).max(64),
    title: z.string().min(5).max(200),
    source: z.enum(BACKUP_SOURCES),
    /** What this procedure recovers from, in the words the trigger would use. */
    appliesTo: z.string().min(15).max(500),
    /** Ordered. A procedure whose steps can be done in any order has not been written down. */
    steps: z
      .array(
        z
          .object({
            title: z.string().min(3).max(200),
            action: z.string().min(10).max(2000),
            /** How the operator knows this step worked before moving on. */
            verification: z.string().min(5).max(500),
            /** Roughly how long, from the last time somebody did it. Null until measured. */
            observedMinutes: z.number().int().nonnegative().max(10_080).nullable().default(null),
          })
          .strict(),
      )
      .min(1),
    /** Who may authorize running this. A restore over live data is not a solo decision. */
    decisionAuthority: z.string().min(3).max(200),
    ownerId: z.string().min(1).max(64),
    lastReviewedAt: z.string().datetime(),
    /** The last time somebody actually followed it. Null is a finding, not a default. */
    lastExercisedAt: z.string().datetime().nullable().default(null),
  })
  .strict();

export type RecoveryProcedure = z.infer<typeof recoveryProcedureSchema>;

export const restoreTestSchema = z
  .object({
    restoreTestId: z.string().min(3).max(64),
    backupId: z.string().min(3).max(64),
    source: z.enum(BACKUP_SOURCES),
    procedureId: z.string().min(3).max(64).nullable().default(null),

    /**
     * Where it ran. Never production.
     *
     * A restore test that writes to production is an outage with a rehearsal attached.
     */
    targetEnvironment: z.enum(['isolated', 'development', 'staging']),
    /** How the target was isolated, so a reader can judge whether it really was. */
    isolationNotes: z.string().min(15).max(1000),

    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),

    checks: z
      .array(
        z
          .object({
            check: z.enum(RESTORE_CHECKS),
            passed: z.boolean(),
            /** What was observed. Required on failure; a failed check with no detail teaches nothing. */
            detail: z.string().max(2000).nullable().default(null),
          })
          .strict()
          .superRefine((entry, ctx) => {
            if (!entry.passed && (entry.detail === null || entry.detail.length < 10)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['detail'],
                message:
                  'A failed check says what was observed, or the next attempt starts from nothing.',
              });
            }
          }),
      )
      .min(1),

    performedBy: z.string().min(1).max(64),
    /** Anything learned that is not a check result — the step that took longer, the missing runbook. */
    observations: z.string().max(5000).nullable().default(null),
    organizationId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict()
  .superRefine((test, ctx) => {
    if (Date.parse(test.completedAt) < Date.parse(test.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completedAt'],
        message: 'A restore test ends after it starts.',
      });
    }

    const seen = new Set<string>();
    for (const [index, entry] of test.checks.entries()) {
      if (seen.has(entry.check)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks', index, 'check'],
          message: `${entry.check} is recorded twice with possibly different results.`,
        });
      }
      seen.add(entry.check);
    }
  });

export type RestoreTest = z.infer<typeof restoreTestSchema>;

export interface RestoreOutcome {
  readonly restoreTestId: string;
  readonly succeeded: boolean;
  /** Measured, from the timestamps. This is what an RTO should be derived from. */
  readonly durationMinutes: number;
  readonly failedChecks: RestoreCheck[];
  /** Required checks that were not performed at all — different from failing them. */
  readonly missingChecks: RestoreCheck[];
  readonly reason: string;
}

/**
 * Evaluate a restore test.
 *
 * A check that was not performed is reported separately from one that failed. Treating them the
 * same lets a test pass by omitting the check it would have failed, and the omission is invisible
 * in a summary that only counts failures.
 */
export function evaluateRestoreTest(
  test: RestoreTest,
  sourceRequirements?: {
    /** Checks that must be performed for this source. Defaults to every required check. */
    required?: readonly RestoreCheck[];
  },
): RestoreOutcome {
  const required =
    sourceRequirements?.required ??
    (RESTORE_CHECKS.filter((check) => CHECK_MEANING[check].required) as readonly RestoreCheck[]);

  const performed = new Map(test.checks.map((entry) => [entry.check, entry.passed]));

  const failedChecks = test.checks.filter((entry) => !entry.passed).map((entry) => entry.check);
  const missingChecks = required.filter((check) => !performed.has(check));

  const durationMinutes = Math.round(
    (Date.parse(test.completedAt) - Date.parse(test.startedAt)) / 60_000,
  );

  const succeeded = failedChecks.length === 0 && missingChecks.length === 0;

  return {
    restoreTestId: test.restoreTestId,
    succeeded,
    durationMinutes,
    failedChecks,
    missingChecks,
    reason: succeeded
      ? `Every required check passed, in ${durationMinutes} minutes.`
      : [
          failedChecks.length > 0 ? `Failed: ${failedChecks.join(', ')}.` : null,
          missingChecks.length > 0
            ? `Not performed: ${missingChecks.join(', ')}. A check that was not run is not a check that passed.`
            : null,
        ]
          .filter(Boolean)
          .join(' '),
  };
}

/**
 * Whether a backup may be marked restore-tested by this test.
 *
 * The gate between the two packages, and the reason `recordRestoreTest` in `@trustos/backup` takes
 * a test id: a backup's strongest claim can only be set from an event that actually happened.
 */
export function assertTestValidates(input: {
  test: RestoreTest;
  backup: BackupRecord;
}): RestoreOutcome {
  if (input.test.backupId !== input.backup.backupId) {
    throw ApiError.validation(
      [{ path: 'backupId', message: 'This test restored a different backup.' }],
      'A restore test validates the backup it restored.',
    );
  }

  const outcome = evaluateRestoreTest(input.test);

  if (!outcome.succeeded) {
    throw ApiError.conflict(`Restore test ${input.test.restoreTestId} did not succeed.`, {
      failedChecks: outcome.failedChecks,
      missingChecks: outcome.missingChecks,
    });
  }

  return outcome;
}

/**
 * The measured restore time for a source, from actual tests.
 *
 * Returns the **slowest** successful test rather than the fastest or the mean. An RTO set from the
 * best run is an RTO met once; the number that matters is what happens when the restore is slow,
 * because that is the run that coincides with the incident.
 */
export function measuredRestoreMinutes(
  tests: readonly RestoreTest[],
  source: BackupSource,
): { minutes: number; fromTestId: string; sampleSize: number } | null {
  const successful = tests
    .filter((test) => test.source === source)
    .map((test) => ({ test, outcome: evaluateRestoreTest(test) }))
    .filter((entry) => entry.outcome.succeeded);

  if (successful.length === 0) return null;

  const slowest = successful.reduce((worst, entry) =>
    entry.outcome.durationMinutes > worst.outcome.durationMinutes ? entry : worst,
  );

  return {
    minutes: slowest.outcome.durationMinutes,
    fromTestId: slowest.test.restoreTestId,
    sampleSize: successful.length,
  };
}

export interface RecoveryFinding {
  readonly kind:
    'never_exercised' | 'stale_procedure' | 'no_measured_duration' | 'unverified_isolation';
  readonly procedureId: string;
  readonly severity: 'high' | 'medium' | 'low';
  readonly detail: string;
}

/**
 * Review procedures against the tests that exercised them.
 *
 * The `never_exercised` finding is the one that matters. A procedure written eighteen months ago
 * and never followed refers to a console that has been redesigned, a role that was renamed and a
 * command that no longer exists — and none of that is visible from reading it.
 */
export function reviewProcedures(input: {
  procedures: readonly RecoveryProcedure[];
  tests: readonly RestoreTest[];
  at: Date;
  exerciseIntervalDays?: number;
}): RecoveryFinding[] {
  const findings: RecoveryFinding[] = [];
  const interval = input.exerciseIntervalDays ?? 180;

  for (const procedure of input.procedures) {
    const exercised = input.tests.filter((test) => test.procedureId === procedure.procedureId);

    if (procedure.lastExercisedAt === null && exercised.length === 0) {
      findings.push({
        kind: 'never_exercised',
        procedureId: procedure.procedureId,
        severity: 'high',
        detail:
          'Never followed. A procedure nobody has run refers to a console that has been redesigned and a command ' +
          'that no longer exists, and none of that is visible from reading it.',
      });
      continue;
    }

    const lastExercised = Math.max(
      procedure.lastExercisedAt ? Date.parse(procedure.lastExercisedAt) : 0,
      ...exercised.map((test) => Date.parse(test.completedAt)),
    );

    const daysSince = Math.floor((input.at.getTime() - lastExercised) / 86_400_000);

    if (daysSince > interval) {
      findings.push({
        kind: 'stale_procedure',
        procedureId: procedure.procedureId,
        severity: 'medium',
        detail: `Last exercised ${daysSince} days ago, against an interval of ${interval}.`,
      });
    }

    if (procedure.steps.every((step) => step.observedMinutes === null)) {
      findings.push({
        kind: 'no_measured_duration',
        procedureId: procedure.procedureId,
        severity: 'medium',
        detail:
          'No step has a measured duration, so any RTO derived from this procedure is an estimate — and the ' +
          'estimate is always shorter than the run.',
      });
    }
  }

  return findings;
}
