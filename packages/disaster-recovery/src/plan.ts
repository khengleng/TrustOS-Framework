import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { ServiceRegistry } from '@trustsystem/sre-core';
import { type RecoveryProcedure, type RestoreTest } from '@trustsystem/recovery';

/**
 * Disaster recovery plans.
 *
 * A DR plan is not a longer runbook. A runbook says what to do; a DR plan additionally says **who
 * decides**, and the deciding is the part that fails. Every DR story that goes badly has the same
 * shape: the technical steps were known, and forty minutes went by while people worked out whether
 * they were allowed to take them.
 *
 * So the schema insists on four things a runbook does not need:
 *
 * **A decision authority, by role, with a named deputy.** The authority is unreachable during
 * exactly the events this covers — that is what "disaster" means — and a plan whose authority is
 * one person is a plan that waits for them.
 *
 * **A communication plan.** Not courtesy: during a region failure the loudest question is "is
 * anyone working on this?", and answering it badly generates a second incident made of people.
 *
 * **Failback.** Failing over is half of it. Running indefinitely on the secondary is a decision
 * nobody made, on infrastructure nobody sized, and the way back is harder than the way out
 * because the two sides have diverged.
 *
 * **Evidence.** What the exercise produced, so a claim of DR capability rests on something.
 *
 * And one refusal: `assertActivatable` will not activate a plan that has never been exercised.
 */

export const DR_SCENARIOS = [
  'infrastructure_failure',
  'database_corruption',
  'provider_outage',
  'region_failure',
  'credential_compromise',
  'deployment_failure',
  'data_corruption',
] as const;
export type DrScenario = (typeof DR_SCENARIOS)[number];

/**
 * What each scenario implies, and the trap in each.
 *
 * `credential_compromise` is the one people get wrong: the instinct is to restore from backup, and
 * a backup taken after the compromise contains whatever the attacker did. It needs a point in time
 * established *before* the compromise, which means knowing when the compromise started — which is
 * usually the hard part and is almost never in the plan.
 */
export const SCENARIO_GUIDANCE: Record<
  DrScenario,
  { readonly meaning: string; readonly trap: string; readonly requiresDataDecision: boolean }
> = {
  infrastructure_failure: {
    meaning: 'The compute the platform runs on is gone or unreachable.',
    trap: 'The recovery target usually shares a control plane with the thing that failed.',
    requiresDataDecision: false,
  },
  database_corruption: {
    meaning: 'The database is available and its contents are wrong.',
    trap: 'Corruption replicates. The standby has it too, and the last clean backup may be older than anybody assumes.',
    requiresDataDecision: true,
  },
  provider_outage: {
    meaning: 'An external provider is unavailable or returning wrong answers.',
    trap: 'A provider returning wrong answers is worse than one returning errors, and health checks pass throughout.',
    requiresDataDecision: false,
  },
  region_failure: {
    meaning: 'An entire cloud region is unavailable.',
    trap: 'Claiming multi-region capability that has never been exercised. Never claim it if it has not.',
    requiresDataDecision: true,
  },
  credential_compromise: {
    meaning: 'A credential with meaningful access is known or believed to be in the wrong hands.',
    trap:
      'Restoring from backup restores whatever the attacker did. This needs a point in time before the compromise, ' +
      'which means establishing when it started — usually the hard part, and almost never in the plan.',
    requiresDataDecision: true,
  },
  deployment_failure: {
    meaning: 'A release has broken production and rolling back is not straightforward.',
    trap: 'A migration that ran. Code rolls back; a schema change does not, and the old code cannot read the new schema.',
    requiresDataDecision: true,
  },
  data_corruption: {
    meaning: 'Application data is wrong — bad writes rather than storage failure.',
    trap: 'The corruption has been replicating for an unknown period, so the blast radius is a question, not a fact.',
    requiresDataDecision: true,
  },
};

export const drPlanSchema = z
  .object({
    planId: z.string().min(3).max(64),
    scenario: z.enum(DR_SCENARIOS),
    title: z.string().min(5).max(200),

    /** What starts this plan, in observable terms rather than in conclusions. */
    trigger: z.string().min(20).max(1000),

    /** Services this plan covers. */
    serviceIds: z.array(z.string().min(3).max(64)).min(1),

    ownerId: z.string().min(1).max(64),

    /**
     * Who decides to invoke, by role — and a deputy, because the authority is unreachable during
     * exactly the events this covers.
     */
    decisionAuthority: z.string().min(3).max(200),
    deputyAuthority: z.string().min(3).max(200),

    /** Ordered steps. Each states its verification, because a step nobody can confirm is a guess. */
    procedure: z
      .array(
        z
          .object({
            title: z.string().min(3).max(200),
            action: z.string().min(10).max(2000),
            verification: z.string().min(5).max(500),
            /** Who performs it, by role. */
            performedBy: z.string().min(2).max(120),
          })
          .strict(),
      )
      .min(1),

    /** Restore procedures this plan depends on, from @trustsystem/recovery. */
    recoveryProcedureIds: z.array(z.string().min(3).max(64)).default([]),

    /**
     * For scenarios that need it: how the recovery point is chosen.
     *
     * Required for corruption and compromise, where "restore the latest backup" is the wrong
     * answer and the reason it is wrong takes a paragraph.
     */
    dataDecision: z.string().min(30).max(2000).nullable().default(null),

    communication: z
      .object({
        /** Who is told, in what order. */
        audiences: z.array(z.string().min(3).max(200)).min(1),
        /** How, when the usual channel may itself be down. */
        channels: z.array(z.string().min(3).max(200)).min(1),
        /** Who speaks. One voice, or the status page and the support queue disagree. */
        spokespersonRole: z.string().min(3).max(120),
        /** How often, even when there is nothing new — silence is read as nobody working on it. */
        cadenceMinutes: z.number().int().min(5).max(1440),
      })
      .strict(),

    /** How the platform confirms it is actually recovered, beyond "it starts". */
    validation: z.array(z.string().min(10).max(500)).min(1),

    /**
     * The way back.
     *
     * Required. Failing over is half of it; running indefinitely on the secondary is a decision
     * nobody made, and the way back is harder because the two sides have diverged.
     */
    failback: z
      .object({
        procedure: z.string().min(30).max(5000),
        /** How data written during the failover is reconciled. Usually the hard part. */
        dataReconciliation: z.string().min(20).max(2000),
        decisionAuthority: z.string().min(3).max(200),
      })
      .strict(),

    /** Targets, in minutes. Set by the owner; never defaulted. */
    rtoMinutes: z.number().int().positive().max(20_160),
    rpoMinutes: z.number().int().nonnegative().max(20_160),

    lastReviewedAt: z.string().datetime(),
    /** Exercises, newest last. Empty means this plan has never been run. */
    exercises: z
      .array(
        z
          .object({
            exerciseId: z.string().min(3).max(64),
            performedAt: z.string().datetime(),
            /** Whether it was a walkthrough, a partial or a full failover. All three count differently. */
            kind: z.enum(['tabletop', 'partial', 'full']),
            /** Measured, not planned. */
            achievedMinutes: z.number().int().nonnegative().max(20_160).nullable().default(null),
            succeeded: z.boolean(),
            /** What was learned. An exercise with no findings was not looked at hard enough. */
            findings: z.array(z.string().min(10).max(1000)).default([]),
            evidenceRef: z.string().min(3).max(300).nullable().default(null),
          })
          .strict(),
      )
      .default([]),

    organizationId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (SCENARIO_GUIDANCE[plan.scenario].requiresDataDecision && plan.dataDecision === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dataDecision'],
        message: `For ${plan.scenario}: ${SCENARIO_GUIDANCE[plan.scenario].trap} State how the recovery point is chosen.`,
      });
    }

    if (plan.decisionAuthority === plan.deputyAuthority) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deputyAuthority'],
        message:
          'The deputy is the same as the authority, so the plan waits for one person during exactly the events where they are unreachable.',
      });
    }
  });

export type DrPlan = z.infer<typeof drPlanSchema>;

export interface DrReadiness {
  readonly planId: string;
  readonly exercised: boolean;
  /** A tabletop is not a failover. Both are useful; only one proves the procedure runs. */
  readonly exercisedFully: boolean;
  readonly lastExerciseAt: string | null;
  /** Measured against the target, from actual exercises. Null when never measured. */
  readonly achievedMinutes: number | null;
  readonly meetsRto: boolean | null;
  readonly openFindings: number;
  readonly statement: string;
}

/**
 * What can honestly be claimed about a plan.
 *
 * Written to be quoted in a readiness scorecard, so the wording is deliberately careful: a plan
 * exercised only as a tabletop gets a statement that says so, because "DR tested" covering a
 * meeting is how a scorecard becomes fiction.
 */
export function readinessOf(plan: DrPlan): DrReadiness {
  const successful = plan.exercises.filter((exercise) => exercise.succeeded);
  const full = successful.filter((exercise) => exercise.kind === 'full');
  const latest = plan.exercises.at(-1) ?? null;

  const measured = full
    .map((exercise) => exercise.achievedMinutes)
    .filter((minutes): minutes is number => minutes !== null);

  const achievedMinutes = measured.length > 0 ? Math.max(...measured) : null;

  const statement =
    full.length > 0
      ? achievedMinutes === null
        ? `Exercised as a full failover, but no duration was recorded, so the ${plan.rtoMinutes}-minute RTO is unverified.`
        : `Exercised as a full failover in ${achievedMinutes} minutes against a ${plan.rtoMinutes}-minute RTO.`
      : successful.length > 0
        ? `Exercised as a ${successful.map((e) => e.kind).join(' and ')} only. The procedure has been walked through, not run.`
        : 'Never exercised. Nothing is known about whether this plan works.';

  return {
    planId: plan.planId,
    exercised: successful.length > 0,
    exercisedFully: full.length > 0,
    lastExerciseAt: latest?.performedAt ?? null,
    achievedMinutes,
    meetsRto: achievedMinutes === null ? null : achievedMinutes <= plan.rtoMinutes,
    openFindings: plan.exercises.reduce((total, exercise) => total + exercise.findings.length, 0),
    statement,
  };
}

/**
 * Refuse to activate a plan nobody has run.
 *
 * `force` exists because a real disaster is not the moment to be blocked by governance, and a
 * refusal with no override would simply be worked around outside the system — losing the record.
 * It requires a reason, and the reason lands in the activation record.
 */
export function assertActivatable(input: {
  plan: DrPlan;
  force?: { by: string; reason: string };
}): void {
  const readiness = readinessOf(input.plan);
  if (readiness.exercised) return;

  if (input.force) {
    if (input.force.reason.trim().length < 20) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'Say why an unexercised plan is being activated.' }],
        'Overriding requires a reason that will read sensibly in the review.',
      );
    }
    return;
  }

  throw ApiError.conflict(
    `${input.plan.planId} has never been exercised, so nothing is known about whether it works. ` +
      'Activate it with a recorded override if the situation warrants it.',
    { scenario: input.plan.scenario },
  );
}

export interface DrFinding {
  readonly kind:
    | 'never_exercised'
    | 'tabletop_only'
    | 'rto_not_met'
    | 'rto_unmeasured'
    | 'covers_unregistered_service'
    | 'missing_recovery_procedure'
    | 'scenario_uncovered';
  readonly planId: string | null;
  readonly severity: 'high' | 'medium' | 'low';
  readonly detail: string;
}

/**
 * Review the DR estate.
 *
 * `scenario_uncovered` reports scenarios with no plan at all, which is the gap that does not show
 * up when you review plans one at a time — every plan looks fine and the missing one is invisible.
 */
export function reviewPlans(input: {
  plans: readonly DrPlan[];
  registry?: Pick<ServiceRegistry, 'get'>;
  procedures?: readonly RecoveryProcedure[];
  restoreTests?: readonly RestoreTest[];
  /** Scenarios this deployment expects to cover. Defaults to all of them. */
  expectedScenarios?: readonly DrScenario[];
}): DrFinding[] {
  const findings: DrFinding[] = [];
  const procedureIds = new Set((input.procedures ?? []).map((procedure) => procedure.procedureId));

  for (const plan of input.plans) {
    const readiness = readinessOf(plan);

    if (!readiness.exercised) {
      findings.push({
        kind: 'never_exercised',
        planId: plan.planId,
        severity: 'high',
        detail: 'Never exercised. Nothing is known about whether this plan works.',
      });
    } else if (!readiness.exercisedFully) {
      findings.push({
        kind: 'tabletop_only',
        planId: plan.planId,
        severity: 'medium',
        detail: 'Exercised as a walkthrough only. The procedure has been read, not run.',
      });
    } else if (readiness.achievedMinutes === null) {
      findings.push({
        kind: 'rto_unmeasured',
        planId: plan.planId,
        severity: 'medium',
        detail: `Exercised fully but with no recorded duration, so the ${plan.rtoMinutes}-minute RTO is a target rather than a measurement.`,
      });
    } else if (readiness.meetsRto === false) {
      findings.push({
        kind: 'rto_not_met',
        planId: plan.planId,
        severity: 'high',
        detail: `Achieved ${readiness.achievedMinutes} minutes against a ${plan.rtoMinutes}-minute RTO. Either the procedure or the target is wrong.`,
      });
    }

    if (input.registry) {
      for (const serviceId of plan.serviceIds) {
        if (input.registry.get(serviceId) === null) {
          findings.push({
            kind: 'covers_unregistered_service',
            planId: plan.planId,
            severity: 'low',
            detail: `Covers ${serviceId}, which is not in the service registry.`,
          });
        }
      }
    }

    if (input.procedures) {
      for (const procedureId of plan.recoveryProcedureIds) {
        if (!procedureIds.has(procedureId)) {
          findings.push({
            kind: 'missing_recovery_procedure',
            planId: plan.planId,
            severity: 'high',
            detail: `Depends on recovery procedure ${procedureId}, which does not exist.`,
          });
        }
      }
    }
  }

  const covered = new Set(input.plans.map((plan) => plan.scenario));
  for (const scenario of input.expectedScenarios ?? DR_SCENARIOS) {
    if (!covered.has(scenario)) {
      findings.push({
        kind: 'scenario_uncovered',
        planId: null,
        severity: 'medium',
        detail: `No plan covers ${scenario}. ${SCENARIO_GUIDANCE[scenario].meaning}`,
      });
    }
  }

  return findings;
}

/**
 * The honest capability statement for the whole estate.
 *
 * Exists because of one line in the specification — *do not claim multi-region DR if it has not
 * been implemented* — and because the temptation to round up is strongest in the summary sentence
 * that leadership reads.
 */
export function capabilityStatement(plans: readonly DrPlan[]): string {
  const region = plans.find((plan) => plan.scenario === 'region_failure');

  if (!region) {
    return 'No region-failure plan exists. Multi-region recovery is not a capability this platform has.';
  }

  const readiness = readinessOf(region);

  if (!readiness.exercisedFully) {
    return `A region-failure plan exists and ${readiness.exercised ? 'has been walked through' : 'has never been exercised'}. Multi-region recovery is documented, not demonstrated.`;
  }

  return `Region failover has been exercised end to end${readiness.achievedMinutes !== null ? ` in ${readiness.achievedMinutes} minutes` : ''} (${region.exercises.at(-1)?.evidenceRef ?? 'no evidence reference recorded'}).`;
}
