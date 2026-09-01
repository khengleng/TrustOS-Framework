import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { circuitBreakerPolicySchema, retryPolicySchema } from '@trustsystem/retry';
import { DEPENDENCY_KINDS, type Service } from '@trustsystem/sre-core';

/**
 * Resilience, declared.
 *
 * `@trustsystem/retry` already provides the mechanisms — backoff, jitter, circuit breakers. What it
 * cannot provide is the *decision*: for this dependency, in this service, what happens when it is
 * unavailable? That decision gets made during the outage otherwise, by whoever is on call, from
 * whatever they can reconstruct at the time.
 *
 * This package makes it a declaration reviewed in advance, and then checks the declaration for
 * the three ways it is usually wrong:
 *
 * **Retrying something that is not safe to retry.** A retry on a non-idempotent write is a
 * duplicate payment. The declaration must state the idempotency mechanism, or retry is refused.
 *
 * **A fallback that quietly succeeds.** Serving stale data or a default is often right, but a
 * caller that cannot tell it received a fallback will treat it as fresh. Every fallback declares
 * how it is visible.
 *
 * **A budget that exceeds the caller's patience.** Three retries with exponential backoff behind
 * a two-second timeout is a system that has decided to fail slowly instead of quickly. The
 * arithmetic is checkable, so it is checked.
 */

export const DEGRADATION_MODES = [
  /** Return the error. Correct when a wrong answer is worse than no answer. */
  'fail_fast',
  /** Serve a previous answer, marked as stale. */
  'serve_stale',
  /** Serve a declared default, marked as a default. */
  'serve_default',
  /** Accept the request and complete it later. Requires durable storage. */
  'queue_for_later',
  /** Answer with reduced scope — fewer fields, fewer results. */
  'reduced_functionality',
  /** Refuse this feature and keep the rest of the service working. */
  'shed_feature',
] as const;
export type DegradationMode = (typeof DEGRADATION_MODES)[number];

export const DEGRADATION_GUIDANCE: Record<
  DegradationMode,
  {
    readonly meaning: string;
    readonly requiresVisibility: boolean;
    readonly requiresDurability: boolean;
  }
> = {
  fail_fast: {
    meaning: 'The caller gets an error immediately and decides for itself.',
    requiresVisibility: false,
    requiresDurability: false,
  },
  serve_stale: {
    meaning: 'A previous answer is served. The caller must be able to tell it is old.',
    requiresVisibility: true,
    requiresDurability: false,
  },
  serve_default: {
    meaning: 'A declared default is served. The caller must be able to tell it is a default.',
    requiresVisibility: true,
    requiresDurability: false,
  },
  queue_for_later: {
    meaning: 'The request is accepted now and completed when the dependency returns.',
    requiresVisibility: true,
    requiresDurability: true,
  },
  reduced_functionality: {
    meaning: 'A partial answer is served, with the missing part named.',
    requiresVisibility: true,
    requiresDurability: false,
  },
  shed_feature: {
    meaning: 'This capability is refused so the rest of the service keeps working.',
    requiresVisibility: false,
    requiresDurability: false,
  },
};

/**
 * A bulkhead: the cap on concurrent calls to one dependency.
 *
 * Its purpose is not the dependency's protection but the *caller's*. Without a cap, a downstream
 * that has become slow rather than broken absorbs every worker in the calling service, and the
 * calling service stops answering requests that have nothing to do with that dependency. That is
 * how one slow integration takes down a service that does six other things perfectly well.
 */
export const bulkheadSchema = z
  .object({
    maxConcurrent: z.number().int().min(1).max(10_000),
    /** Requests that may wait for a slot. Zero means excess is refused immediately. */
    maxQueued: z.number().int().min(0).max(100_000).default(0),
    /** How long a request waits for a slot before being refused. */
    queueTimeoutMs: z.number().int().min(0).max(60_000).default(0),
  })
  .strict();

export type Bulkhead = z.infer<typeof bulkheadSchema>;

export const fallbackSchema = z
  .object({
    mode: z.enum(DEGRADATION_MODES),
    description: z.string().min(15).max(1000),
    /**
     * How the caller can tell it received a fallback rather than a live answer — a response
     * header, a field, a distinct status. Required for every mode that returns something.
     */
    visibleTo: z.string().min(5).max(300).nullable().default(null),
    /** For `serve_stale`: how old an answer may be before it is worse than an error. */
    maxStalenessSeconds: z.number().int().positive().max(2_592_000).nullable().default(null),
    /** For `queue_for_later`: where the request is stored so it survives a restart. */
    durableStore: z.string().min(3).max(200).nullable().default(null),
    /** What the business consequence of this degradation is. Somebody should have decided. */
    businessImpact: z.string().min(15).max(1000),
    approvedBy: z.string().min(1).max(64),
  })
  .strict()
  .superRefine((fallback, ctx) => {
    const guidance = DEGRADATION_GUIDANCE[fallback.mode];

    if (guidance.requiresVisibility && fallback.visibleTo === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['visibleTo'],
        message:
          `${fallback.mode} returns something other than the live answer. State how the caller can tell — ` +
          'a fallback the caller reads as fresh is worse than an error.',
      });
    }

    if (guidance.requiresDurability && fallback.durableStore === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durableStore'],
        message:
          'Queueing for later means the request survives a restart. Name where it is stored.',
      });
    }

    if (fallback.mode === 'serve_stale' && fallback.maxStalenessSeconds === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxStalenessSeconds'],
        message:
          'State how old an answer may be. Unbounded staleness is a cache that never expires.',
      });
    }
  });

export type Fallback = z.infer<typeof fallbackSchema>;

export const dependencyResilienceSchema = z
  .object({
    dependencyId: z.string().min(1).max(64),
    kind: z.enum(DEPENDENCY_KINDS),
    /** Wall-clock cap for one call, before any retry. */
    timeoutMs: z.number().int().min(1).max(600_000),
    /**
     * Total time this dependency may consume, including every retry and every backoff.
     *
     * The number the caller's own timeout must exceed. Declaring it separately is what makes the
     * arithmetic checkable rather than emergent.
     */
    totalBudgetMs: z.number().int().min(1).max(600_000),
    retry: retryPolicySchema.nullable().default(null),
    /**
     * Why retrying this is safe: the idempotency key, the natural idempotence, the compensation.
     * Required whenever a retry policy is present.
     */
    retrySafety: z.string().min(15).max(500).nullable().default(null),
    circuitBreaker: circuitBreakerPolicySchema.nullable().default(null),
    bulkhead: bulkheadSchema.nullable().default(null),
    fallback: fallbackSchema,
  })
  .strict()
  .superRefine((declaration, ctx) => {
    if (declaration.retry && declaration.retrySafety === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retrySafety'],
        message:
          'A retry on an operation that is not idempotent is a duplicate. Say what makes this one safe to repeat.',
      });
    }

    if (declaration.totalBudgetMs < declaration.timeoutMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalBudgetMs'],
        message: 'The total budget is at least one call.',
      });
    }
  });

export type DependencyResilience = z.infer<typeof dependencyResilienceSchema>;

export const servicePostureSchema = z
  .object({
    serviceId: z.string().min(3).max(64),
    /**
     * How long the service's own callers wait. Every dependency budget must fit inside this, or
     * the caller gives up while the service is still politely retrying.
     */
    callerTimeoutMs: z.number().int().min(1).max(600_000),
    dependencies: z.array(dependencyResilienceSchema).default([]),
    reviewedAt: z.string().datetime(),
    reviewedBy: z.string().min(1).max(64),
  })
  .strict();

export type ServicePosture = z.infer<typeof servicePostureSchema>;

export interface PostureFinding {
  readonly kind:
    | 'budget_exceeds_caller_timeout'
    | 'retry_without_breaker'
    | 'critical_without_fallback'
    | 'undeclared_dependency'
    | 'unprotected_dependency'
    | 'fallback_masks_failure';
  readonly dependencyId: string;
  readonly severity: 'high' | 'medium' | 'low';
  readonly detail: string;
}

/**
 * How long a dependency can actually take, worst case.
 *
 * The number people are surprised by. A 2s timeout with three exponential retries is not 2s and
 * it is not 8s; it is the timeouts plus the backoffs, and it usually exceeds the caller's
 * patience by a wide margin.
 */
export function worstCaseLatencyMs(declaration: DependencyResilience): number {
  if (!declaration.retry) return declaration.timeoutMs;

  /*
   * `maxAttempts` in `@trustsystem/retry` counts retries *after* the first call, so three retries is
   * four calls and three waits. Getting this off by one is how a budget check passes and the
   * caller still times out.
   */
  const calls = declaration.retry.maxAttempts + 1;
  let backoff = 0;

  for (let attempt = 1; attempt <= declaration.retry.maxAttempts; attempt += 1) {
    const base =
      declaration.retry.strategy === 'exponential'
        ? declaration.retry.initialDelayMs * Math.pow(declaration.retry.multiplier, attempt - 1)
        : declaration.retry.strategy === 'linear'
          ? declaration.retry.initialDelayMs * attempt
          : declaration.retry.initialDelayMs;

    backoff += Math.min(base, declaration.retry.maxDelayMs);
  }

  return declaration.timeoutMs * calls + Math.round(backoff);
}

/**
 * Review a posture against the service it belongs to.
 *
 * `service` is optional so a posture can be checked before the service is registered; supplying it
 * additionally catches dependencies declared in one place and not the other, which is the state a
 * posture drifts into as dependencies get added.
 */
export function reviewPosture(input: { posture: ServicePosture; service?: Service }): {
  sound: boolean;
  findings: PostureFinding[];
} {
  const findings: PostureFinding[] = [];

  for (const declaration of input.posture.dependencies) {
    const worstCase = worstCaseLatencyMs(declaration);

    if (worstCase > input.posture.callerTimeoutMs) {
      findings.push({
        kind: 'budget_exceeds_caller_timeout',
        dependencyId: declaration.dependencyId,
        severity: 'high',
        detail:
          `Worst case ${worstCase}ms against a caller timeout of ${input.posture.callerTimeoutMs}ms. ` +
          'The caller gives up while the service is still retrying, so the retries cost capacity and buy nothing.',
      });
    }

    if (worstCase > declaration.totalBudgetMs) {
      findings.push({
        kind: 'budget_exceeds_caller_timeout',
        dependencyId: declaration.dependencyId,
        severity: 'medium',
        detail: `Declared budget ${declaration.totalBudgetMs}ms, but the retry schedule reaches ${worstCase}ms.`,
      });
    }

    if (declaration.retry && !declaration.circuitBreaker) {
      findings.push({
        kind: 'retry_without_breaker',
        dependencyId: declaration.dependencyId,
        severity: 'medium',
        detail:
          'Retrying without a breaker multiplies load on a downstream that is already failing, ' +
          'so the thing that needed a moment to recover never gets one.',
      });
    }

    if (!declaration.circuitBreaker && !declaration.bulkhead && !declaration.retry) {
      findings.push({
        kind: 'unprotected_dependency',
        dependencyId: declaration.dependencyId,
        severity: 'low',
        detail:
          'No timeout budget protection beyond the call timeout. Acceptable, but state that it is deliberate.',
      });
    }

    /*
     * A silent fallback on a critical dependency is the worst combination in this file: the
     * service reports healthy, the SLI counts a success, and the wrong answer reaches a customer.
     */
    const guidance = DEGRADATION_GUIDANCE[declaration.fallback.mode];
    if (guidance.requiresVisibility && declaration.fallback.visibleTo === null) {
      findings.push({
        kind: 'fallback_masks_failure',
        dependencyId: declaration.dependencyId,
        severity: 'high',
        detail: 'The fallback returns something the caller cannot distinguish from a live answer.',
      });
    }
  }

  if (input.service) {
    const declared = new Set(input.posture.dependencies.map((d) => d.dependencyId));

    for (const dependency of input.service.dependencies) {
      if (!declared.has(dependency.dependencyId)) {
        findings.push({
          kind: 'undeclared_dependency',
          dependencyId: dependency.dependencyId,
          severity: dependency.critical ? 'high' : 'medium',
          detail:
            `The service depends on ${dependency.dependencyId} but the posture says nothing about what happens ` +
            'when it is unavailable. That decision then gets made during the outage.',
        });
      }
    }

    for (const declaration of input.posture.dependencies) {
      const match = input.service.dependencies.find(
        (d) => d.dependencyId === declaration.dependencyId,
      );
      if (
        match?.critical &&
        declaration.fallback.mode === 'fail_fast' &&
        match.degradedBehaviour.length === 0
      ) {
        findings.push({
          kind: 'critical_without_fallback',
          dependencyId: declaration.dependencyId,
          severity: 'medium',
          detail:
            'A critical dependency that fails fast propagates its outage. Confirm that is intended.',
        });
      }
    }
  }

  return { sound: findings.every((finding) => finding.severity !== 'high'), findings };
}

/** A posture with unresolved high-severity findings is not one to deploy behind. */
export function assertPostureSound(input: { posture: ServicePosture; service?: Service }): void {
  const { sound, findings } = reviewPosture(input);
  if (sound) return;

  throw ApiError.conflict(
    `The resilience posture for ${input.posture.serviceId} has unresolved high-severity findings.`,
    {
      findings: findings
        .filter((finding) => finding.severity === 'high')
        .map((finding) => `${finding.dependencyId}: ${finding.detail}`),
    },
  );
}

/**
 * What the service does right now, given which dependencies are unavailable.
 *
 * Reads the declaration rather than deciding anything, which is the point: the answer to "what
 * happens when the ledger is down" should be the same at 3am as it was at the design review.
 */
export function degradationPlan(input: {
  posture: ServicePosture;
  unavailableDependencyIds: readonly string[];
}): Array<{
  dependencyId: string;
  mode: DegradationMode;
  effect: string;
  visibleTo: string | null;
}> {
  return input.posture.dependencies
    .filter((declaration) => input.unavailableDependencyIds.includes(declaration.dependencyId))
    .map((declaration) => ({
      dependencyId: declaration.dependencyId,
      mode: declaration.fallback.mode,
      effect: declaration.fallback.businessImpact,
      visibleTo: declaration.fallback.visibleTo,
    }));
}
