import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { DEPENDENCY_KINDS, type Service } from '@trustos/sre-core';
import type { ServicePosture } from '@trustos/resilience';

/**
 * Controlled failure injection.
 *
 * The specification's constraint is one sentence — *do not perform destructive production chaos
 * tests automatically* — and it is the whole design. Not because chaos engineering is wrong, but
 * because the framework cannot know whether this deployment is a sandbox or a bank, and the
 * failure mode of guessing wrong is unbounded.
 *
 * So the rules are, in order of how much they matter:
 *
 * **Nothing runs in production without a named human approver.** Not a flag, not a config value —
 * an approver id and a timestamp on the experiment itself, checked at start.
 *
 * **Destructive faults cannot run in production at all.** Data deletion and corruption are refused
 * outright there, with no override, because there is no correct value for "who may corrupt the
 * production ledger to see what happens".
 *
 * **Every experiment declares its abort condition and its blast radius before it starts.** An
 * experiment that cannot say what "too far" looks like has no way to stop, and the person watching
 * it is deciding under time pressure whether the thing they are seeing is the experiment working
 * or an incident.
 *
 * **A steady-state hypothesis, stated first.** Otherwise the result is whatever the observer
 * concluded afterwards, which is always that the system coped.
 */

export const FAULT_KINDS = [
  'dependency_timeout',
  'dependency_error',
  'provider_outage',
  'database_unavailable',
  'database_slow',
  'queue_backlog',
  'ai_provider_failure',
  'network_latency',
  'job_failure',
  'instance_termination',
  'data_deletion',
  'data_corruption',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * What each fault does, and whether it may ever run against production.
 *
 * The two `false` entries are not a policy default a deployment adjusts. They are a refusal: there
 * is no configuration under which deleting production data to observe the result is the right
 * call, and offering the setting is how it eventually gets set.
 */
export const FAULT_PROFILE: Record<
  FaultKind,
  {
    readonly description: string;
    readonly destructive: boolean;
    /** Whether this fault may run in production at all, with approval. */
    readonly productionPermitted: boolean;
    /** What it is expected to reveal, which is what the hypothesis should be about. */
    readonly reveals: string;
  }
> = {
  dependency_timeout: {
    description: 'A declared dependency stops answering within its timeout.',
    destructive: false,
    productionPermitted: true,
    reveals: 'Whether the declared timeout and fallback are what the code actually does.',
  },
  dependency_error: {
    description: 'A dependency returns errors rather than hanging.',
    destructive: false,
    productionPermitted: true,
    reveals: 'Whether the breaker opens, and whether the error reaches the caller intelligibly.',
  },
  provider_outage: {
    description: 'An external provider is unavailable for the duration.',
    destructive: false,
    productionPermitted: true,
    reveals: 'Whether the secondary provider is actually reachable and configured.',
  },
  database_unavailable: {
    description: 'The database refuses connections.',
    destructive: false,
    productionPermitted: false,
    reveals: 'Whether readiness fails cleanly rather than the process restarting in a loop.',
  },
  database_slow: {
    description: 'Database queries take an order of magnitude longer.',
    destructive: false,
    productionPermitted: false,
    reveals: 'Whether connection pools bulkhead, or one slow table starves everything.',
  },
  queue_backlog: {
    description: 'Consumers stop, and the queue depth grows.',
    destructive: false,
    productionPermitted: true,
    reveals: 'Whether backlog is detected before it becomes unrecoverable, and whether it drains.',
  },
  ai_provider_failure: {
    description: 'The AI gateway returns errors or times out.',
    destructive: false,
    productionPermitted: true,
    reveals:
      'Whether AI features degrade rather than blocking the transaction they were attached to.',
  },
  network_latency: {
    description: 'Latency is added between services.',
    destructive: false,
    productionPermitted: true,
    reveals: 'Whether timeouts are set relative to real latency or to a local development machine.',
  },
  job_failure: {
    description: 'A scheduled job fails or does not run.',
    destructive: false,
    productionPermitted: true,
    reveals: 'Whether a missed job is noticed, or discovered a week later by its absence.',
  },
  instance_termination: {
    description: 'An instance is terminated without warning.',
    destructive: false,
    productionPermitted: true,
    reveals: 'Whether in-flight work is lost, retried, or completed twice.',
  },
  data_deletion: {
    description: 'Records are deleted to observe recovery.',
    destructive: true,
    productionPermitted: false,
    reveals: 'Whether the restore path works — which is what a restore test establishes, safely.',
  },
  data_corruption: {
    description: 'Records are modified to observe detection.',
    destructive: true,
    productionPermitted: false,
    reveals: 'Whether integrity checks catch it — which reconciliation tests establish, safely.',
  },
};

export const experimentSchema = z
  .object({
    experimentId: z.string().min(3).max(64),
    title: z.string().min(5).max(200),
    fault: z.enum(FAULT_KINDS),

    targetServiceId: z.string().min(3).max(64),
    /** The dependency to fault, when the fault is about one. */
    targetDependencyId: z.string().min(1).max(64).nullable().default(null),
    targetDependencyKind: z.enum(DEPENDENCY_KINDS).nullable().default(null),

    environment: z.enum(['development', 'staging', 'production']),

    /**
     * What is expected to remain true throughout.
     *
     * Stated first, and this is the difference between an experiment and an outage: without a
     * hypothesis, the result is whatever the observer concluded afterwards, which is always that
     * the system coped.
     */
    steadyStateHypothesis: z.string().min(30).max(1000),

    /** How the hypothesis is measured, so the answer is not a matter of opinion. */
    measuredBy: z.array(z.string().min(10).max(300)).min(1),

    /**
     * How far this reaches: which consumers, which tenants, what fraction of traffic.
     *
     * Declared before, because the honest answer is often larger than expected and finding that
     * out while writing it down is much cheaper than finding out during the run.
     */
    blastRadius: z.string().min(20).max(1000),

    /** Fraction of traffic affected, 0..1. */
    trafficFraction: z.number().min(0).max(1),

    durationSeconds: z.number().int().min(1).max(7200),

    /**
     * What ends the experiment early.
     *
     * Required. An experiment that cannot say what "too far" looks like has no way to stop, and
     * the person watching decides under time pressure whether what they are seeing is the
     * experiment working or an incident starting.
     */
    abortConditions: z.array(z.string().min(10).max(300)).min(1),
    /** How it is stopped. A condition with no stop is an observation. */
    abortProcedure: z.string().min(20).max(1000),

    ownerId: z.string().min(1).max(64),

    /** Required to run in production. A person, not a flag. */
    approvedBy: z.string().min(1).max(64).nullable().default(null),
    approvedAt: z.string().datetime().nullable().default(null),

    organizationId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict()
  .superRefine((experiment, ctx) => {
    const profile = FAULT_PROFILE[experiment.fault];

    if (experiment.environment === 'production' && !profile.productionPermitted) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['environment'],
        message: profile.destructive
          ? `${experiment.fault} is destructive and never runs against production. ${profile.reveals}`
          : `${experiment.fault} does not run against production; use staging, where the same thing is learned.`,
      });
    }

    if (experiment.environment === 'production' && experiment.approvedBy === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedBy'],
        message: 'A production experiment names the person who approved it. Not a flag — a person.',
      });
    }

    if (
      ['dependency_timeout', 'dependency_error', 'provider_outage'].includes(experiment.fault) &&
      experiment.targetDependencyId === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetDependencyId'],
        message: 'A dependency fault names the dependency it faults.',
      });
    }
  });

export type Experiment = z.infer<typeof experimentSchema>;

/**
 * The gate before an experiment starts.
 *
 * Checked at run time rather than only at definition time, because an experiment defined against
 * staging and then run with a production target is exactly the mistake this needs to catch — and
 * it is a mistake somebody makes with a copied command line, not with a malicious intent.
 */
export function assertRunnable(input: {
  experiment: Experiment;
  service?: Service;
  posture?: ServicePosture;
  at: Date;
  /** Set when an incident is currently open. */
  activeIncidents?: number;
}): void {
  const profile = FAULT_PROFILE[input.experiment.fault];
  const problems: string[] = [];

  if (input.experiment.environment === 'production') {
    if (!profile.productionPermitted) {
      throw ApiError.forbidden(
        `${input.experiment.fault} does not run against production under any configuration. ${profile.reveals}`,
        { reason: 'fault_not_permitted_in_production' },
      );
    }

    if (input.experiment.approvedBy === null || input.experiment.approvedAt === null) {
      throw ApiError.forbidden(
        'A production experiment requires a named approver recorded on the experiment itself.',
        { reason: 'not_approved' },
      );
    }

    if (input.experiment.ownerId === input.experiment.approvedBy) {
      throw ApiError.forbidden(
        'The owner of an experiment does not approve their own production run — the same separation the framework applies everywhere else.',
        { reason: 'self_approved' },
      );
    }
  }

  /*
   * Not during an incident. Injecting a fault while something is already broken makes the incident
   * harder to diagnose and the experiment impossible to interpret, and the two get confused with
   * each other in the timeline afterwards.
   */
  if ((input.activeIncidents ?? 0) > 0) {
    throw ApiError.conflict(
      'An incident is open. A fault injected now is indistinguishable from the incident in the timeline afterwards.',
      { reason: 'incident_open' },
    );
  }

  if (input.service && input.experiment.targetDependencyId) {
    const declared = input.service.dependencies.some(
      (dependency) => dependency.dependencyId === input.experiment.targetDependencyId,
    );

    if (!declared) {
      problems.push(
        `${input.service.serviceId} does not declare a dependency called ${input.experiment.targetDependencyId}.`,
      );
    }
  }

  /*
   * An experiment against a dependency with no declared resilience posture will simply confirm
   * that nothing was in place. That is a finding for a review, not an experiment worth running.
   */
  if (input.posture && input.experiment.targetDependencyId) {
    const declared = input.posture.dependencies.some(
      (dependency) => dependency.dependencyId === input.experiment.targetDependencyId,
    );

    if (!declared) {
      problems.push(
        `The resilience posture says nothing about ${input.experiment.targetDependencyId}, so this experiment ` +
          'would confirm that nothing is in place — which a posture review establishes without the fault.',
      );
    }
  }

  if (problems.length > 0) {
    throw ApiError.conflict('This experiment is not runnable as configured.', { problems });
  }
}

export const experimentResultSchema = z
  .object({
    experimentId: z.string().min(3).max(64),
    runId: z.string().min(3).max(64),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    /** Whether the steady state held. The answer to the hypothesis, not to "did it run". */
    hypothesisHeld: z.boolean(),
    /** True when an abort condition fired. Not a failure — it is the safety mechanism working. */
    aborted: z.boolean(),
    abortReason: z.string().min(10).max(500).nullable().default(null),
    /** What was observed, against `measuredBy`. */
    observations: z.array(z.string().min(10).max(1000)).min(1),
    /** What should change as a result. An experiment with no findings taught nothing. */
    findings: z.array(z.string().min(10).max(1000)).default([]),
    runBy: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.aborted && result.abortReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['abortReason'],
        message: 'An aborted run says which condition fired.',
      });
    }
  });

export type ExperimentResult = z.infer<typeof experimentResultSchema>;

/**
 * What an experiment established.
 *
 * A hypothesis that held is the *weaker* result, and the wording says so. It means the system
 * behaved as expected under one fault for one duration at one traffic fraction — not that the
 * system is resilient.
 */
export function interpret(input: { experiment: Experiment; result: ExperimentResult }): {
  learned: string;
  actionable: boolean;
} {
  const { experiment, result } = input;

  if (result.aborted) {
    return {
      learned: `Aborted: ${result.abortReason}. The abort mechanism worked, which is worth knowing; the hypothesis is untested.`,
      actionable: true,
    };
  }

  if (!result.hypothesisHeld) {
    return {
      learned: `The steady state did not hold under ${experiment.fault}. ${result.observations.join(' ')}`,
      actionable: true,
    };
  }

  return {
    learned:
      `The steady state held under ${experiment.fault} for ${experiment.durationSeconds}s at ` +
      `${Math.round(experiment.trafficFraction * 100)}% of traffic in ${experiment.environment}. ` +
      'That is one fault, one duration, one fraction — not a statement about the system.',
    actionable: result.findings.length > 0,
  };
}

/** Faults that have never been run against a service, so nothing is known about them. */
export function untestedFaults(input: {
  serviceId: string;
  experiments: readonly Experiment[];
  results: readonly ExperimentResult[];
}): FaultKind[] {
  const run = new Set(
    input.experiments
      .filter(
        (experiment) =>
          experiment.targetServiceId === input.serviceId &&
          input.results.some((result) => result.experimentId === experiment.experimentId),
      )
      .map((experiment) => experiment.fault),
  );

  return FAULT_KINDS.filter((fault) => !FAULT_PROFILE[fault].destructive && !run.has(fault));
}
