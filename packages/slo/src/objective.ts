import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { SLI_DIRECTION, type SliDefinition, type SliValue } from '@trustos/sli';
import { TIER_EXPECTATIONS, type ServiceTier } from '@trustos/sre-core';

/**
 * Objectives and error budgets.
 *
 * An objective without a budget is a target; an objective with one is a decision rule. The budget
 * is the arithmetic that turns "99.9% availability" into "we may fail 43 minutes this month, and
 * we have spent 31 of them" — which is a sentence a team can act on.
 *
 * The framework's position on what happens when the budget runs out is the same position it takes
 * everywhere: **the policy is declared in advance and it is not automatic**. An exhausted budget
 * produces *recommended* actions with a stated reason. It does not stop a deployment by itself,
 * because a rule that halts production without a human in the loop will be disabled after the
 * first time it is wrong, and then it protects nothing.
 */

export const BUDGET_STATES = ['healthy', 'warning', 'exhausted'] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

export const GOVERNANCE_ACTIONS = [
  'stop_risky_rollout',
  'require_incident_review',
  'pause_nonessential_deployment',
  'freeze_feature_work',
  'notify_service_owner',
] as const;
export type GovernanceAction = (typeof GOVERNANCE_ACTIONS)[number];

export const budgetPolicySchema = z
  .object({
    /** Fraction of the budget consumed at which this rule starts applying, 0..1. */
    consumedAtLeast: z.number().min(0).max(1),
    state: z.enum(BUDGET_STATES),
    actions: z.array(z.enum(GOVERNANCE_ACTIONS)).min(1),
    /** Said to the team, in the notification. A rule that cannot explain itself gets ignored. */
    rationale: z.string().min(15).max(500),
  })
  .strict();

export type BudgetPolicy = z.infer<typeof budgetPolicySchema>;

/**
 * The framework default.
 *
 * Note what is *not* here: nothing stops production traffic, and nothing rolls back automatically.
 * The strongest default action is to stop shipping risk, which is reversible and which a human
 * decides to override in daylight.
 */
export const DEFAULT_BUDGET_POLICIES: readonly BudgetPolicy[] = [
  {
    consumedAtLeast: 0,
    state: 'healthy',
    actions: ['notify_service_owner'],
    rationale: 'The budget is intact; the team may spend it on shipping.',
  },
  {
    consumedAtLeast: 0.75,
    state: 'warning',
    actions: ['notify_service_owner', 'stop_risky_rollout'],
    rationale:
      'Three quarters of the budget is spent with time left in the window. Continuing to ship risk spends the rest.',
  },
  {
    consumedAtLeast: 1,
    state: 'exhausted',
    actions: ['stop_risky_rollout', 'require_incident_review', 'pause_nonessential_deployment'],
    rationale:
      'The reliability the objective promised has already been missed. Further change is deferred until the cause is understood.',
  },
];

export const sloSchema = z
  .object({
    sloId: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/, 'Lowercase dotted or dashed identifier.'),
    serviceId: z.string().min(3).max(64),
    sliId: z.string().min(3).max(64),
    name: z.string().min(3).max(120),
    /** The target, as a percentage. 99.9 means 99.9%. */
    target: z.number().min(0).max(100),
    /** Rolling window in days. 28 and 30 are the usual choices; a quarter hides too much. */
    windowDays: z.number().int().min(1).max(90),
    /**
     * Whether this objective is a commitment or an experiment. A pilot objective is measured and
     * reported and explicitly *not* a promise — the specification is emphatic about that
     * distinction and it belongs in the data, not in a footnote.
     */
    status: z.enum(['pilot', 'committed', 'retired']).default('pilot'),
    ownerTeam: z.string().min(2).max(120),
    budgetPolicies: z
      .array(budgetPolicySchema)
      .min(1)
      .default([...DEFAULT_BUDGET_POLICIES]),
    /** How few valid events make the window unjudgeable. Null defers to the ratio test. */
    minimumEvents: z.number().int().positive().nullable().default(null),
    organizationId: z.string().min(1).max(64).nullable().default(null),
    effectiveFrom: z.string().datetime(),
  })
  .strict()
  .superRefine((slo, ctx) => {
    const states = new Set(slo.budgetPolicies.map((policy) => policy.state));

    if (!states.has('exhausted')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['budgetPolicies'],
        message:
          'An objective states what happens when its budget is exhausted. Deciding that during the incident is how nothing is decided.',
      });
    }

    if (!slo.budgetPolicies.some((policy) => policy.consumedAtLeast === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['budgetPolicies'],
        message: 'A policy applies from zero consumption, so every level of consumption resolves.',
      });
    }
  });

export type Slo = z.infer<typeof sloSchema>;

export interface ErrorBudget {
  readonly sloId: string;
  readonly target: number;
  /** Events the objective permits to be bad across the window. */
  readonly allowedBadEvents: number;
  readonly badEvents: number;
  readonly remainingBadEvents: number;
  /** Fraction of the budget spent, 0..1 and unclamped above 1 — 1.4 means 40% overspent. */
  readonly consumed: number;
  readonly state: BudgetState;
  readonly actions: readonly GovernanceAction[];
  readonly rationale: string;
}

export interface SloStatus {
  readonly sloId: string;
  readonly serviceId: string;
  readonly measured: number | null;
  readonly target: number;
  /**
   * `met`, `missed`, or — the state that keeps this honest — `insufficient_data`. An objective
   * cannot be reported as met by a window that could not have detected a miss.
   */
  readonly verdict: 'met' | 'missed' | 'insufficient_data';
  readonly reason: string;
  readonly budget: ErrorBudget | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** A pilot objective is measured and reported; it is not a commitment anybody may rely on. */
  readonly isCommitment: boolean;
}

function resolvePolicy(slo: Slo, consumed: number): BudgetPolicy {
  const applicable = slo.budgetPolicies
    .filter((policy) => consumed >= policy.consumedAtLeast)
    .sort((a, b) => b.consumedAtLeast - a.consumedAtLeast);

  const policy = applicable[0];
  if (!policy) {
    // Unreachable while the schema holds; stated rather than assumed.
    throw ApiError.internal('No budget policy applies, which the objective schema should prevent.');
  }
  return policy;
}

/**
 * The budget.
 *
 * Computed from event counts rather than from minutes, because that is what the indicator
 * measures. Minutes-of-downtime is a derived presentation, and deriving it requires assuming a
 * uniform request rate that no real service has.
 */
export function errorBudget(slo: Slo, value: SliValue): ErrorBudget | null {
  if (value.ratio === null) return null;

  const allowedFailureFraction = (100 - slo.target) / 100;
  const allowedBadEvents = allowedFailureFraction * value.validEvents;
  const badEvents = value.validEvents - value.goodEvents;

  const consumed =
    allowedBadEvents === 0 ? (badEvents > 0 ? Infinity : 0) : badEvents / allowedBadEvents;
  const policy = resolvePolicy(slo, consumed);

  return {
    sloId: slo.sloId,
    target: slo.target,
    allowedBadEvents: Number(allowedBadEvents.toFixed(2)),
    badEvents,
    remainingBadEvents: Number(Math.max(0, allowedBadEvents - badEvents).toFixed(2)),
    consumed: Number.isFinite(consumed) ? Number(consumed.toFixed(4)) : consumed,
    state: policy.state,
    actions: policy.actions,
    rationale: policy.rationale,
  };
}

/**
 * Evaluate an objective against a measured value.
 *
 * The `insufficient_data` verdict is the one that matters. Without it, a service that received
 * four requests all night reports as meeting a 99.9% objective, and the report is technically
 * true and completely misleading.
 */
export function evaluateSlo(
  slo: Slo,
  value: SliValue,
  sufficiency: { sufficient: boolean; reason: string | null },
): SloStatus {
  const shared = {
    sloId: slo.sloId,
    serviceId: slo.serviceId,
    measured: value.percentage,
    target: slo.target,
    windowStart: value.windowStart,
    windowEnd: value.windowEnd,
    isCommitment: slo.status === 'committed',
  };

  if (!sufficiency.sufficient) {
    return {
      ...shared,
      verdict: 'insufficient_data',
      reason: sufficiency.reason ?? 'The window cannot judge this objective.',
      budget: errorBudget(slo, value),
    };
  }

  const budget = errorBudget(slo, value);
  const met = (value.percentage as number) >= slo.target;

  return {
    ...shared,
    verdict: met ? 'met' : 'missed',
    reason: met
      ? `Measured ${value.percentage}% against a target of ${slo.target}%.`
      : `Measured ${value.percentage}%, below the target of ${slo.target}%.`,
    budget,
  };
}

/**
 * The burn rate: how fast the budget is being spent relative to the window.
 *
 * A burn rate of 1 spends the budget exactly at the end of the window. 14.4 spends a 30-day budget
 * in two hours — the number worth paging on, because by the time absolute consumption is alarming
 * the outage has been running for hours.
 *
 * This is why a burn-rate alert catches what a threshold alert does not: the threshold fires when
 * the damage is done, the burn rate fires while it is happening.
 */
export function burnRate(input: {
  slo: Slo;
  value: SliValue;
  /** How long the measured value covers, in hours. */
  observedHours: number;
}): number | null {
  if (input.value.ratio === null || input.observedHours <= 0) return null;

  const allowedFailureFraction = (100 - input.slo.target) / 100;
  if (allowedFailureFraction === 0) return null;

  const observedFailureFraction = 1 - input.value.ratio;
  const rate = observedFailureFraction / allowedFailureFraction;
  return Number(rate.toFixed(4));
}

/**
 * Whether the burn rate warrants waking somebody.
 *
 * The multi-window discipline: a fast burn over a short window pages, a slower burn over a long
 * one raises a ticket. A single window either pages on transients or misses slow bleeds.
 */
export function burnAlert(input: { fastBurn: number | null; slowBurn: number | null }): {
  severity: 'page' | 'ticket' | 'none';
  reason: string;
} {
  if (input.fastBurn !== null && input.fastBurn >= 14.4) {
    return {
      severity: 'page',
      reason: `Burning ${input.fastBurn}× the sustainable rate. At this rate the whole window's budget is gone within hours.`,
    };
  }

  if (input.slowBurn !== null && input.slowBurn >= 3) {
    return {
      severity: 'ticket',
      reason: `Burning ${input.slowBurn}× the sustainable rate over the longer window. Not an emergency, but the budget will not last.`,
    };
  }

  return { severity: 'none', reason: 'Burn rate is within what the window sustains.' };
}

/**
 * Whether an objective is consistent with its service's tier and its indicator.
 *
 * Two failures worth catching before an objective is committed rather than after it is missed: a
 * tier-1 service carrying a target below what tier 1 means, and an objective written against an
 * `error_rate` indicator as though higher were better — which inverts the whole thing and reads
 * plausibly.
 */
export function validateObjective(input: {
  slo: Slo;
  tier: ServiceTier;
  indicator: SliDefinition;
}): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const expectation = TIER_EXPECTATIONS[input.tier];

  if (input.slo.sliId !== input.indicator.sliId) {
    problems.push(
      `The objective names indicator ${input.slo.sliId} but was checked against ${input.indicator.sliId}.`,
    );
  }

  if (input.indicator.serviceId !== input.slo.serviceId) {
    problems.push('The objective and its indicator describe different services.');
  }

  if (SLI_DIRECTION[input.indicator.kind] === 'lower_is_better') {
    problems.push(
      `Indicator kind ${input.indicator.kind} counts bad events, so a "greater than or equal" target inverts it. ` +
        'Express the objective against a success indicator instead.',
    );
  }

  if (input.slo.status === 'committed' && input.slo.target < expectation.minimumAvailability) {
    problems.push(
      `A ${input.tier} service commits to at least ${expectation.minimumAvailability}%; this objective promises ${input.slo.target}%.`,
    );
  }

  if (input.slo.target === 100) {
    problems.push(
      'A target of 100% leaves no budget, so every deployment is a violation and the objective stops being used.',
    );
  }

  return { valid: problems.length === 0, problems };
}
