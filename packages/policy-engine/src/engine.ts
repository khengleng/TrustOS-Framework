import { ApiError } from '@trustsystem/errors';
import type { Policy, AuthorizationRequest, PolicyResult } from '@trustsystem/authorization';
import {
  ACTIVE_POLICY_STATUSES,
  PolicyRegistry,
  type PolicyCategory,
  type PolicyDocument,
} from '@trustsystem/policy-registry';
import {
  analysePolicy,
  assertObligationsUnderstood,
  evaluatePolicy,
  explainDecision,
  runPolicyTests,
  type PolicyAttributes,
  type PolicyDecision,
} from '@trustsystem/policy-evaluator';
import { PolicyDecisionLog, type PolicyDecisionRecord } from '@trustsystem/policy-decision-log';

/**
 * The centralized policy decision point.
 *
 * Registry plus evaluator plus decision log, with the two things a decision point has to do that
 * none of the three does alone: **default to deny across the whole set**, and **record every
 * decision**.
 *
 * The relationship to `@trustsystem/authorization` is the question worth answering first, because two
 * policy systems in one platform is usually a mistake.
 *
 * `@trustsystem/authorization` decides **who may call what**. Its policies are code, they are part of
 * the platform's structure, they change with a release, and they are evaluated on every request
 * by a guard. That is correct for "may this actor invoke this route".
 *
 * This engine decides **what the rules currently are**. Its policies are documents, a deployment
 * changes them without a release, they carry versions and approval, and every decision is logged
 * so it can be re-derived. That is correct for "is MFA required above this amount today".
 *
 * They compose rather than compete: `asAuthorizationPolicy` wraps an engine decision as a phase-4
 * `Policy`, so a document policy participates in the same default-deny evaluation as a code one.
 * The engine can only **refuse** through that adapter — a document policy that could grant would
 * be a way to widen access by editing configuration, which is the failure this whole part exists
 * to make visible rather than possible.
 */

export interface PolicyEngineOptions {
  registry: PolicyRegistry;
  log: PolicyDecisionLog;
  /** Obligation kinds this deployment can honour. An unknown obligation is a denial. */
  supportedObligations: readonly string[];
  newDecisionId: () => string;
  now?: () => Date;
}

export interface DecideInput {
  policyId: string;
  /** Pin a version for a replay. Omitted means the active one. */
  policyVersion?: string;
  attributes: PolicyAttributes;
  actorId: string;
  organizationId: string | null;
  action: string;
  resourceId?: string | null;
  sensitiveAttributes?: readonly string[];
  correlationId: string;
}

export interface EngineDecision extends PolicyDecision {
  record: PolicyDecisionRecord;
}

export class PolicyEngine {
  private readonly now: () => Date;

  constructor(private readonly options: PolicyEngineOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Decides, and records.
   *
   * The recording is not optional and not conditional on the outcome. A decision point that
   * logged only denials would answer "what did we refuse" and not "what did we permit", and the
   * second is the question an auditor asks about a breach.
   */
  async decide(input: DecideInput): Promise<EngineDecision> {
    const startedAt = process.hrtime.bigint();
    const policy = this.options.registry.require(input.policyId, input.policyVersion);

    if (!ACTIVE_POLICY_STATUSES.has(policy.status)) {
      /*
       * A pinned version that is not active may be *replayed* but never *enforced*.
       *
       * This path is reachable only when a caller pinned a version explicitly, which is what a
       * re-derivation does. Enforcing a draft would mean an unreviewed policy takes effect the
       * moment somebody writes it.
       */
      throw new ApiError('forbidden', {
        message:
          `Policy ${policy.policyId}@${policy.version} is "${policy.status}" and cannot decide. ` +
          'A draft policy that could decide would take effect the moment somebody wrote it.',
        context: { policyId: policy.policyId, version: policy.version, status: policy.status },
      });
    }

    const decision = evaluatePolicy(policy, input.attributes);
    assertObligationsUnderstood(decision, this.options.supportedObligations);

    const durationMicros = Number((process.hrtime.bigint() - startedAt) / 1000n);

    const record = await this.options.log.record({
      decision,
      actorId: input.actorId,
      organizationId: input.organizationId,
      action: input.action,
      resourceId: input.resourceId ?? null,
      attributes: input.attributes,
      ...(input.sensitiveAttributes ? { sensitiveAttributes: input.sensitiveAttributes } : {}),
      correlationId: input.correlationId,
      decidedAt: this.now(),
      durationMicros,
      newDecisionId: this.options.newDecisionId,
    });

    return { ...decision, record };
  }

  /** Decides, and throws on a denial with the reason attached. */
  async assert(input: DecideInput): Promise<EngineDecision> {
    const decision = await this.decide(input);

    if (decision.decision === 'ALLOW') return decision;

    throw new ApiError('forbidden', {
      message: decision.reasons.join(' '),
      context: {
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
        ruleId: decision.ruleId,
        decisionId: decision.record.decisionId,
      },
    });
  }

  /**
   * Simulates, without recording and without touching anything.
   *
   * `trustos policy simulate` is this. It may evaluate a **draft** version, which `decide`
   * refuses — simulating an unapproved policy is the entire point of simulating.
   */
  simulate(input: { policyId: string; policyVersion?: string; attributes: PolicyAttributes }): {
    decision: PolicyDecision;
    explanation: string[];
  } {
    const versions = this.options.registry.versionsOf(input.policyId);

    const policy = input.policyVersion
      ? versions.find((candidate) => candidate.version === input.policyVersion)
      : (versions[versions.length - 1] ?? undefined);

    if (!policy) {
      throw new ApiError('not_found', {
        message: `No policy "${input.policyId}"${input.policyVersion ? ` at ${input.policyVersion}` : ''}.`,
        context: { policyId: input.policyId },
      });
    }

    const decision = evaluatePolicy(policy, input.attributes);
    return { decision, explanation: explainDecision(decision) };
  }

  /**
   * Whether a policy may be activated.
   *
   * Its own tests must pass and its static analysis must be clean of errors. A policy is
   * configuration with consequences, and configuration with consequences that nobody tested is
   * the change that goes out on a Friday.
   */
  validate(policy: PolicyDocument): {
    valid: boolean;
    findings: ReturnType<typeof analysePolicy>;
    tests: ReturnType<typeof runPolicyTests>;
  } {
    const findings = analysePolicy(policy);
    const tests = runPolicyTests(policy);

    return {
      valid: tests.passed && !findings.some((finding) => finding.severity === 'error'),
      findings,
      tests,
    };
  }

  byCategory(category: PolicyCategory): PolicyDocument[] {
    return this.options.registry.byCategory(category);
  }
}

/**
 * Wraps an engine decision as a phase-4 authorization policy.
 *
 * The adapter that lets document policies and code policies compose. It can only **refuse** —
 * `evaluate` returns `deny` or `null`, never `allow` — because a document policy that could grant
 * would be a way to widen access by editing configuration, and that is precisely the failure this
 * part exists to make visible rather than possible.
 *
 * It is deliberately **synchronous and pre-resolved**: the decision is made before the guard runs
 * and passed in. A policy that performed I/O inside `evaluate` would be a policy that makes every
 * authorization decision wait on a database, and one that times out during an incident.
 */
export function asAuthorizationPolicy(input: {
  policyId: string;
  /** The decision, already made. Resolved by the caller before `authorize` is invoked. */
  decisionFor: (request: AuthorizationRequest) => PolicyDecision | null;
}): Policy {
  return {
    id: `policy-engine.${input.policyId}`,
    description: `The "${input.policyId}" document policy, as an authorization policy. Refuses only.`,

    appliesTo: (request) => input.decisionFor(request) !== null,

    evaluate: (request): PolicyResult | null => {
      const decision = input.decisionFor(request);
      if (!decision) return null;

      /*
       * An ALLOW returns null — abstain — rather than allow.
       *
       * The document policy's job here is to add a refusal the code policies do not know about.
       * Granting would mean a configuration change could widen access past a code policy that
       * refused, and the whole default-deny structure would then depend on nobody writing an
       * over-broad document policy.
       */
      if (decision.decision === 'ALLOW') return null;

      return {
        effect: 'deny',
        reason: `${decision.policyId}@${decision.policyVersion}: ${decision.reasons.join(' ')}`,
      };
    },
  };
}

export { evaluatePolicy, explainDecision, analysePolicy, runPolicyTests };
