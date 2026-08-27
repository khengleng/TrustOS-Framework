import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { conditionSchema } from '@trustos/workflow-definition';
import { compareVersions, isNewer } from '@trustos/version-manager';

/**
 * The policy registry.
 *
 * Policies as versioned, immutable documents with their own lifecycle. The framework already has
 * an authorization engine (`@trustos/authorization`) whose policies are **code** — TypeScript
 * objects with an `evaluate` method — and that is the right shape for the fifteen or so decisions
 * that are part of the platform's own structure.
 *
 * This is for the other kind: the decisions a *deployment* makes and changes without a release.
 * "MFA is required above this amount." "This consumer plan gets this quota." "Exports of
 * restricted data need two approvals in Cambodia and one elsewhere." Those are configuration with
 * consequences, and configuration with consequences needs versions, approval and a decision log —
 * which is what this part adds and what code policies cannot have.
 *
 * The condition language is `@trustos/workflow-definition`'s predicate tree, imported whole. Its
 * header explains at length why a condition is a tree rather than an expression string; all of it
 * applies here, and a third condition language in this repository would be a third place to get
 * it wrong.
 *
 * **A published version is immutable.** Same rule as a workflow definition and a financial
 * product, same reason: a decision recorded against version 3 must be reproducible from version 3
 * forever, and it is not if version 3 can change.
 */

export const POLICY_CATEGORIES = [
  'security',
  'data',
  'financial',
  'ai',
  'api',
  'operations',
  'deployment',
] as const;

export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export const POLICY_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'active',
  'deprecated',
  'retired',
] as const;

export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/**
 * What a policy can decide.
 *
 * `allow` and `deny` are the decision. **Obligations** are the third thing, and the reason the
 * result is not a boolean: a policy that permits an export *provided it is watermarked and
 * expires in four hours* is a different answer from one that simply permits it, and collapsing
 * the two loses the conditions somebody attached deliberately.
 *
 * An obligation the caller does not understand is a **denial**. That is the rule that makes them
 * safe: a caller that silently ignored an unknown obligation would turn every future obligation
 * into a no-op for every existing caller.
 */
export const obligationSchema = z
  .object({
    /** What must be done. A closed vocabulary per deployment, checked by the caller. */
    kind: z.string().regex(/^[a-z][a-z0-9_]{2,49}$/),
    /** Bounded scalars. An obligation carrying a structure is a second policy language. */
    parameters: z
      .record(z.union([z.string().max(200), z.number(), z.boolean()]))
      .refine((value) => Object.keys(value).length <= 10, 'At most 10 parameters.')
      .default({}),
    description: z.string().min(5).max(300),
  })
  .strict();

export type Obligation = z.infer<typeof obligationSchema>;

export const policyRuleSchema = z
  .object({
    ruleId: z.string().regex(/^[a-z][a-z0-9-]{2,59}$/),
    description: z.string().min(10).max(300),
    /** Evaluation order. Lower runs first; the first matching rule decides. */
    priority: z.number().int().min(0).max(999),
    when: conditionSchema,
    effect: z.enum(['allow', 'deny']),
    obligations: z.array(obligationSchema).max(10).default([]),
    /** Why this rule exists. Quoted back to whoever it refused. */
    reason: z.string().min(10).max(300),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.effect === 'deny' && rule.obligations.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message:
          'A denial with obligations is a contradiction: the action is not happening, so there ' +
          'is nothing to oblige. If the intent is "allow, but only if", the effect is allow.',
      });
    }
  });

export type PolicyRule = z.infer<typeof policyRuleSchema>;

/**
 * A test case, on the policy.
 *
 * Required — at least one, and at least one of each outcome the policy can produce. A policy with
 * no tests is a policy nobody can change safely, and the person who wrote it is the only one who
 * knows what it was supposed to do. Requiring both outcomes catches the policy that denies
 * everything, which passes any set of deny-only tests.
 */
export const policyTestCaseSchema = z
  .object({
    name: z.string().min(3).max(120),
    attributes: z.record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
    expect: z.enum(['allow', 'deny']),
    expectedRuleId: z.string().max(60).optional(),
  })
  .strict();

export type PolicyTestCase = z.infer<typeof policyTestCaseSchema>;

export const policyDocumentSchema = z
  .object({
    policyId: z.string().regex(/^[a-z][a-z0-9.-]{2,79}$/),
    name: z.string().min(3).max(120),
    description: z.string().min(20).max(600),
    category: z.enum(POLICY_CATEGORIES),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),

    owner: z.string().min(1).max(80),
    status: z.enum(POLICY_STATUSES),

    /** Ordered by priority at evaluation, not by array position. */
    rules: z.array(policyRuleSchema).min(1).max(200),
    /**
     * What happens when no rule matches.
     *
     * `deny`, and the schema refuses anything else. A policy whose default is allow is a policy
     * that permits everything it did not think of, and the things a policy did not think of are
     * exactly the interesting ones.
     */
    defaultEffect: z.literal('deny'),

    testCases: z.array(policyTestCaseSchema).min(1).max(200),

    effectiveDate: z.string().datetime(),
    reviewDate: z.string().datetime(),
    /** Required when deprecated. */
    supersededBy: z.string().max(80).optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const ruleIds = new Set<string>();

    for (const [index, rule] of policy.rules.entries()) {
      if (ruleIds.has(rule.ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'ruleId'],
          message: `Two rules share the id "${rule.ruleId}".`,
        });
      }
      ruleIds.add(rule.ruleId);
    }

    const outcomes = new Set(policy.testCases.map((testCase) => testCase.expect));
    const effects = new Set(policy.rules.map((rule) => rule.effect));

    if (effects.has('allow') && !outcomes.has('allow')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['testCases'],
        message:
          'This policy can allow and no test case expects an allow. A policy that denies ' +
          'everything passes any set of deny-only tests.',
      });
    }

    if (!outcomes.has('deny')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['testCases'],
        message:
          'No test case expects a deny. Every policy can deny — the default is deny — so a ' +
          'policy with no denying test has not been tested against its own default.',
      });
    }

    if (policy.status === 'deprecated' && !policy.supersededBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message: 'A deprecated policy names its successor.',
      });
    }

    if (new Date(policy.reviewDate) <= new Date(policy.effectiveDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewDate'],
        message: 'The review date must be after the effective date.',
      });
    }
  });

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

/** Statuses in which a policy actually decides anything. */
export const ACTIVE_POLICY_STATUSES: ReadonlySet<PolicyStatus> = new Set(['active']);

export class PolicyRegistry {
  private readonly versions = new Map<string, PolicyDocument[]>();

  constructor(policies: readonly PolicyDocument[] = []) {
    for (const policy of policies) this.publish(policy);
  }

  /**
   * Publishes a version.
   *
   * Refuses a re-publication of an existing version, whatever changed in it. That is the
   * immutability rule, and it is checked here rather than trusted: a decision recorded against
   * version 3 must be reproducible from version 3 forever.
   */
  publish(input: unknown): PolicyDocument {
    const policy = policyDocumentSchema.parse(input);
    const existing = this.versions.get(policy.policyId) ?? [];

    if (existing.some((candidate) => candidate.version === policy.version)) {
      throw new ApiError('conflict', {
        message:
          `Policy ${policy.policyId} already has a version ${policy.version}. A published ` +
          'version never changes — a decision recorded against it must be reproducible from it ' +
          'forever. Publish a new version.',
        context: { policyId: policy.policyId, version: policy.version },
      });
    }

    const newest = existing[existing.length - 1];

    if (newest && !isNewer(policy.version, newest.version)) {
      throw new ApiError('validation_error', {
        message: `Version ${policy.version} is not newer than ${newest.version}.`,
        context: { policyId: policy.policyId },
      });
    }

    this.versions.set(policy.policyId, [...existing, Object.freeze(policy)]);
    return policy;
  }

  find(policyId: string, version?: string): PolicyDocument | undefined {
    const versions = this.versions.get(policyId) ?? [];
    if (version) return versions.find((candidate) => candidate.version === version);

    /*
     * The newest *active* version, not simply the newest.
     *
     * A draft version 4 sitting above an active 3 must not start deciding because somebody
     * published it — publishing is not activation, and conflating them is how an unreviewed
     * policy takes effect.
     */
    return [...versions]
      .reverse()
      .find((candidate) => ACTIVE_POLICY_STATUSES.has(candidate.status));
  }

  require(policyId: string, version?: string): PolicyDocument {
    const policy = this.find(policyId, version);

    if (!policy) {
      const versions = this.versions.get(policyId) ?? [];

      throw new ApiError('not_found', {
        message: versions.length
          ? `Policy ${policyId} has no active version. Versions: ` +
            `${versions.map((candidate) => `${candidate.version} (${candidate.status})`).join(', ')}.`
          : `No policy "${policyId}".`,
        context: { policyId, ...(version ? { version } : {}) },
      });
    }

    return policy;
  }

  versionsOf(policyId: string): PolicyDocument[] {
    return [...(this.versions.get(policyId) ?? [])];
  }

  byCategory(category: PolicyCategory): PolicyDocument[] {
    return [...this.versions.values()]
      .map((versions) =>
        [...versions].reverse().find((policy) => ACTIVE_POLICY_STATUSES.has(policy.status)),
      )
      .filter(
        (policy): policy is PolicyDocument => policy !== undefined && policy.category === category,
      )
      .sort((left, right) => left.policyId.localeCompare(right.policyId));
  }

  /** Active policies whose review has passed. */
  overdueReviews(asOf: Date): PolicyDocument[] {
    return [...this.versions.values()]
      .map((versions) =>
        [...versions].reverse().find((policy) => ACTIVE_POLICY_STATUSES.has(policy.status)),
      )
      .filter(
        (policy): policy is PolicyDocument =>
          policy !== undefined && new Date(policy.reviewDate) < asOf,
      );
  }

  size(): number {
    return [...this.versions.values()].reduce((total, versions) => total + versions.length, 0);
  }
}

/** Whether a version bump is large enough for what changed. */
export function assertSufficientPolicyBump(previous: PolicyDocument, next: PolicyDocument): void {
  if (compareVersions(previous.version, next.version) >= 0) {
    throw new ApiError('validation_error', {
      message: `Version ${next.version} is not newer than ${previous.version}.`,
    });
  }

  const removedRules = previous.rules.filter(
    (rule) => !next.rules.some((candidate) => candidate.ruleId === rule.ruleId),
  );

  const loosened = previous.rules.filter((rule) => {
    const successor = next.rules.find((candidate) => candidate.ruleId === rule.ruleId);
    return successor && rule.effect === 'deny' && successor.effect === 'allow';
  });

  if (removedRules.length === 0 && loosened.length === 0) return;

  const [previousMajor] = previous.version.split('.');
  const [nextMajor] = next.version.split('.');

  if (previousMajor !== nextMajor) return;

  throw new ApiError('validation_error', {
    message:
      `This version removes ${removedRules.length} rule(s) and turns ${loosened.length} denial(s) ` +
      'into allowances, which is a loosening. A loosening gets a major bump, so that a version ' +
      'number alone tells a reviewer whether a policy became more permissive.',
    context: { policyId: next.policyId, from: previous.version, to: next.version },
  });
}
