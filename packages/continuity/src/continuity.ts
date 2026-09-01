import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { TIER_EXPECTATIONS, type ServiceRegistry, type ServiceTier } from '@trustsystem/sre-core';
import { BACKUP_SOURCES, type BackupInventory, type BackupSource } from '@trustsystem/backup';
import { measuredRestoreMinutes, type RestoreTest } from '@trustsystem/recovery';
import { readinessOf, type DrPlan } from '@trustsystem/disaster-recovery';

/**
 * Business continuity.
 *
 * This package holds the RTO and RPO for each critical business process, and then does the one
 * thing that makes those numbers worth recording: it compares them against what has actually been
 * demonstrated.
 *
 * That comparison is the entire contribution. An RTO is a promise, and every organization has a
 * spreadsheet of them. What almost none have is the second column — the measured restore time from
 * a real test, the exercised failover duration, the date the plan was last run — and without it
 * the first column is aspiration formatted as commitment.
 *
 * So `gapAnalysis` returns three kinds of finding, and the third is the interesting one:
 *
 *   **unmet**      — the demonstrated time exceeds the target. Honest and actionable.
 *   **unproven**   — no measurement exists. The target is neither met nor missed; nothing is known.
 *   **unfounded**  — the target is arithmetically impossible given what it depends on. An RPO of
 *                    zero against a backup taken daily is not ambitious, it is wrong, and it reads
 *                    perfectly reasonably in a spreadsheet.
 *
 * The specification says *do not invent targets*, so nothing here defaults an RTO or an RPO. A
 * process without them fails to parse.
 */

export const CRITICALITY_LEVELS = ['critical', 'important', 'standard', 'deferrable'] as const;
export type Criticality = (typeof CRITICALITY_LEVELS)[number];

export const CRITICALITY_MEANING: Record<
  Criticality,
  { readonly meaning: string; readonly maximumRtoMinutes: number }
> = {
  critical: {
    meaning: 'Customers cannot transact and money may be at risk while this is down.',
    maximumRtoMinutes: 60,
  },
  important: {
    meaning: 'A major function is unavailable; a manual workaround exists but does not scale.',
    maximumRtoMinutes: 240,
  },
  standard: {
    meaning: 'Internal or reporting work is delayed. Nobody outside notices within a day.',
    maximumRtoMinutes: 1440,
  },
  deferrable: {
    meaning: 'Can wait until the rest of the platform is recovered.',
    maximumRtoMinutes: 10_080,
  },
};

export const businessProcessSchema = z
  .object({
    processId: z.string().min(3).max(64),
    name: z.string().min(3).max(120),
    description: z.string().min(20).max(1000),
    criticality: z.enum(CRITICALITY_LEVELS),

    /**
     * Recovery time objective, in minutes. Never defaulted.
     *
     * The specification is explicit: do not invent targets, require explicit configuration by the
     * owner. A framework default here would become everybody's number, and nobody's decision.
     */
    rtoMinutes: z.number().int().positive().max(20_160),

    /**
     * Recovery point objective, in minutes. Zero means no data loss is acceptable.
     *
     * Zero is a strong claim: it requires synchronous replication, and it is the number most often
     * written down without the infrastructure that would deliver it.
     */
    rpoMinutes: z.number().int().nonnegative().max(20_160),

    /** The services this process runs on. */
    serviceIds: z.array(z.string().min(3).max(64)).min(1),
    /** The backup sources it depends on to be recoverable. */
    backupSources: z.array(z.enum(BACKUP_SOURCES)).default([]),
    /** DR plans that cover it. */
    drPlanIds: z.array(z.string().min(3).max(64)).default([]),

    /** Who set these numbers, and therefore who owns them being wrong. */
    ownerId: z.string().min(1).max(64),
    /** Whether the business signed off, as distinct from engineering proposing. */
    approvedByBusinessOwner: z.boolean(),

    /** A manual process that keeps the business running while systems are down, if any. */
    manualWorkaround: z.string().min(15).max(1000).nullable().default(null),
    /** An alternate provider, if the process depends on one. */
    alternateProvider: z.string().min(3).max(200).nullable().default(null),

    lastReviewedAt: z.string().datetime(),
    organizationId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict()
  .superRefine((process, ctx) => {
    const meaning = CRITICALITY_MEANING[process.criticality];

    if (process.rtoMinutes > meaning.maximumRtoMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rtoMinutes'],
        message:
          `A ${process.criticality} process with a ${process.rtoMinutes}-minute RTO is not ${process.criticality}. ` +
          `${meaning.meaning} Either the target or the criticality is wrong.`,
      });
    }

    if (process.criticality === 'critical' && !process.approvedByBusinessOwner) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedByBusinessOwner'],
        message:
          'A critical process needs its targets signed off by the business, not proposed by engineering. ' +
          'The cost of meeting an RTO is a business decision.',
      });
    }
  });

export type BusinessProcess = z.infer<typeof businessProcessSchema>;

export interface ContinuityGap {
  readonly kind: 'unmet' | 'unproven' | 'unfounded';
  readonly processId: string;
  readonly objective: 'rto' | 'rpo';
  readonly targetMinutes: number;
  /** What has actually been demonstrated. Null when nothing has. */
  readonly demonstratedMinutes: number | null;
  readonly severity: 'high' | 'medium';
  readonly detail: string;
  /** Where the demonstrated number came from, so it can be checked. */
  readonly evidence: string | null;
}

/**
 * How often a source is backed up, in minutes — the floor on any RPO that depends on it.
 *
 * Derived from the gap between the two most recent successful backups rather than from a stated
 * schedule, because the schedule is what was intended and the gap is what happened.
 */
export function observedBackupIntervalMinutes(
  inventory: Pick<BackupInventory, 'list'>,
  source: BackupSource,
  environment: string,
): number | null {
  const completions = inventory
    .list({ source, environment })
    .filter((backup) => backup.completedAt !== null && backup.failureReason === null)
    .map((backup) => Date.parse(backup.completedAt as string))
    .sort((left, right) => right - left);

  if (completions.length < 2) return null;
  return Math.round(((completions[0] as number) - (completions[1] as number)) / 60_000);
}

/**
 * Compare every promise against what has been demonstrated.
 *
 * The `unfounded` case deserves the emphasis: an RPO of zero against a source backed up daily is
 * not an ambitious target, it is an arithmetic impossibility — and it reads perfectly reasonably in
 * a spreadsheet, which is why it survives review after review.
 */
export function gapAnalysis(input: {
  processes: readonly BusinessProcess[];
  inventory?: Pick<BackupInventory, 'list' | 'lastRestoreTested'>;
  restoreTests?: readonly RestoreTest[];
  drPlans?: readonly DrPlan[];
  environment?: string;
}): ContinuityGap[] {
  const gaps: ContinuityGap[] = [];
  const environment = input.environment ?? 'production';
  const plansById = new Map((input.drPlans ?? []).map((plan) => [plan.planId, plan]));

  for (const process of input.processes) {
    // --- RTO ---------------------------------------------------------------

    const restoreEvidence = process.backupSources
      .map((source) => ({
        source,
        measured: measuredRestoreMinutes(input.restoreTests ?? [], source),
      }))
      .filter((entry) => entry.measured !== null);

    const exerciseEvidence = process.drPlanIds
      .map((planId) => plansById.get(planId))
      .filter((plan): plan is DrPlan => plan !== undefined)
      .map((plan) => ({ plan, readiness: readinessOf(plan) }))
      .filter((entry) => entry.readiness.achievedMinutes !== null);

    /*
     * The worst demonstrated number across everything the process depends on. Recovery is
     * sequential in practice — the database restores, then the application starts, then the
     * failover completes — so taking the best of them describes a recovery nobody has performed.
     */
    const demonstrated = Math.max(
      ...restoreEvidence.map((entry) => entry.measured?.minutes ?? 0),
      ...exerciseEvidence.map((entry) => entry.readiness.achievedMinutes ?? 0),
      0,
    );

    const hasEvidence = restoreEvidence.length > 0 || exerciseEvidence.length > 0;

    if (!hasEvidence) {
      gaps.push({
        kind: 'unproven',
        processId: process.processId,
        objective: 'rto',
        targetMinutes: process.rtoMinutes,
        demonstratedMinutes: null,
        severity: process.criticality === 'critical' ? 'high' : 'medium',
        detail:
          `The ${process.rtoMinutes}-minute RTO has never been measured. It is neither met nor missed; ` +
          'nothing is known about it.',
        evidence: null,
      });
    } else if (demonstrated > process.rtoMinutes) {
      const source =
        restoreEvidence.find((entry) => entry.measured?.minutes === demonstrated)?.measured
          ?.fromTestId ??
        exerciseEvidence.find((entry) => entry.readiness.achievedMinutes === demonstrated)?.plan
          .planId ??
        null;

      gaps.push({
        kind: 'unmet',
        processId: process.processId,
        objective: 'rto',
        targetMinutes: process.rtoMinutes,
        demonstratedMinutes: demonstrated,
        severity: 'high',
        detail: `Demonstrated ${demonstrated} minutes against a ${process.rtoMinutes}-minute target.`,
        evidence: source,
      });
    }

    // --- RPO ---------------------------------------------------------------

    if (input.inventory) {
      for (const source of process.backupSources) {
        const interval = observedBackupIntervalMinutes(input.inventory, source, environment);

        if (interval === null) {
          gaps.push({
            kind: 'unproven',
            processId: process.processId,
            objective: 'rpo',
            targetMinutes: process.rpoMinutes,
            demonstratedMinutes: null,
            severity: process.criticality === 'critical' ? 'high' : 'medium',
            detail: `Fewer than two successful ${source} backups, so the achievable recovery point is unknown.`,
            evidence: null,
          });
          continue;
        }

        if (interval > process.rpoMinutes) {
          gaps.push({
            kind: 'unfounded',
            processId: process.processId,
            objective: 'rpo',
            targetMinutes: process.rpoMinutes,
            demonstratedMinutes: interval,
            severity: 'high',
            detail:
              `The ${process.rpoMinutes}-minute RPO cannot be met from ${source} backups taken every ` +
              `${interval} minutes. This is arithmetic, not a shortfall to work on: up to ${interval} minutes ` +
              'of data would be lost, whatever the target says.',
            evidence: `${source} backup interval, observed`,
          });
        }
      }
    }
  }

  return gaps;
}

export interface ContinuityStatus {
  readonly processId: string;
  readonly name: string;
  readonly criticality: Criticality;
  readonly rtoMinutes: number;
  readonly rpoMinutes: number;
  readonly lastSuccessfulBackupAt: string | null;
  readonly lastRestoreTestAt: string | null;
  readonly drPlansExercised: number;
  readonly drPlansTotal: number;
  readonly gaps: ContinuityGap[];
  /** A single word for a dashboard, derived rather than set. */
  readonly state: 'proven' | 'partial' | 'unproven' | 'at_risk';
}

/**
 * The dashboard row.
 *
 * `state` is derived, and `proven` is deliberately hard to reach: it needs a restore test, an
 * exercised plan and no gaps. Everything else is `partial` at best. A dashboard where most rows are
 * green because green is the default teaches its readers to ignore it.
 */
export function continuityStatus(input: {
  process: BusinessProcess;
  inventory?: Pick<BackupInventory, 'list' | 'lastSuccessful' | 'lastRestoreTested'>;
  restoreTests?: readonly RestoreTest[];
  drPlans?: readonly DrPlan[];
  environment?: string;
}): ContinuityStatus {
  const environment = input.environment ?? 'production';

  const gaps = gapAnalysis({
    processes: [input.process],
    inventory: input.inventory,
    restoreTests: input.restoreTests,
    drPlans: input.drPlans,
    environment,
  });

  const lastBackup =
    input.process.backupSources
      .map((source) => input.inventory?.lastSuccessful(source, environment)?.completedAt ?? null)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;

  const lastRestore =
    input.process.backupSources
      .map(
        (source) =>
          input.inventory?.lastRestoreTested(source, environment)?.lastRestoreTestAt ?? null,
      )
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;

  const plans = (input.drPlans ?? []).filter((plan) =>
    input.process.drPlanIds.includes(plan.planId),
  );
  const exercised = plans.filter((plan) => readinessOf(plan).exercised).length;

  const hasUnmet = gaps.some((gap) => gap.kind === 'unmet' || gap.kind === 'unfounded');
  const proven =
    lastRestore !== null && plans.length > 0 && exercised === plans.length && gaps.length === 0;

  return {
    processId: input.process.processId,
    name: input.process.name,
    criticality: input.process.criticality,
    rtoMinutes: input.process.rtoMinutes,
    rpoMinutes: input.process.rpoMinutes,
    lastSuccessfulBackupAt: lastBackup,
    lastRestoreTestAt: lastRestore,
    drPlansExercised: exercised,
    drPlansTotal: plans.length,
    gaps,
    state: hasUnmet ? 'at_risk' : proven ? 'proven' : lastRestore !== null ? 'partial' : 'unproven',
  };
}

/**
 * Whether a process's continuity claim may be reported as passing.
 *
 * Read by the readiness scorecard. Refuses on any gap, including `unproven` — the specification's
 * *never mark PASS without evidence*, as a function rather than as a reviewer's discipline.
 */
export function assertContinuityProven(status: ContinuityStatus): void {
  if (status.state === 'proven') return;

  throw ApiError.conflict(
    `${status.processId} cannot be reported as continuity-proven: it is ${status.state}.`,
    { gaps: status.gaps.map((gap) => gap.detail) },
  );
}

/**
 * Services carrying critical processes whose tier does not reflect it.
 *
 * The mismatch that produces the 3am surprise: a process the business calls critical running on a
 * service registered as tier 3, which therefore has no rotation and nobody is woken for.
 */
export function tierMismatches(input: {
  processes: readonly BusinessProcess[];
  registry: Pick<ServiceRegistry, 'get'>;
}): Array<{ processId: string; serviceId: string; tier: ServiceTier; detail: string }> {
  const mismatches: Array<{
    processId: string;
    serviceId: string;
    tier: ServiceTier;
    detail: string;
  }> = [];

  for (const process of input.processes) {
    if (process.criticality !== 'critical') continue;

    for (const serviceId of process.serviceIds) {
      const service = input.registry.get(serviceId);
      if (!service) continue;

      if (TIER_EXPECTATIONS[service.tier].rank > 1) {
        mismatches.push({
          processId: process.processId,
          serviceId,
          tier: service.tier,
          detail:
            `${process.name} is critical to the business and runs on ${serviceId}, registered as ${service.tier}` +
            `${service.onCallRotation === null ? ' with nobody on call' : ''}.`,
        });
      }
    }
  }

  return mismatches;
}
