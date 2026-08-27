import { ApiError } from '@trustos/errors';
import { apiClassification, type ApiDefinition, type ApiOperation } from '@trustos/api-catalog';
import { KIND_CEILINGS, type Consumer, type Entitlement } from '@trustos/api-consumer';
import { policyDocumentSchema, type PolicyDocument } from '@trustos/policy-registry';
import {
  evaluatePolicy,
  type PolicyAttributes,
  type PolicyDecision,
} from '@trustos/policy-evaluator';

/**
 * API access as policy.
 *
 * The framework already decides API access in code: `decideAccess` in `@trustos/api-consumer`
 * checks status, environment, entitlement, version and scope. That code is the floor, and it
 * should stay code — it is the same on every deployment and it is not something an operator should
 * be able to weaken through configuration.
 *
 * What differs per deployment is everything *above* the floor: whether a partner may reach
 * restricted data outside business hours, whether a consumer in overage may still call, whether an
 * unreviewed consumer keeps working. Those are policy, and this package expresses them as
 * documents the phase-13 engine evaluates.
 *
 * The composition rule is the same one `@trustos/policy-engine` establishes and is worth repeating
 * because it is what makes configuration safe here: **a document policy can refuse, and can never
 * grant.** Code decides first. If code says no, the answer is no and no document changes it. If
 * code says yes, a document may still refuse. A configuration surface that could widen access past
 * a code refusal would make the whole default-deny structure depend on nobody writing an
 * over-broad document.
 */

/**
 * Attributes an API policy may read.
 *
 * A closed vocabulary, because a policy reading an attribute nobody supplies never fires — and a
 * rule that never fires looks, in a review, exactly like a rule that never needed to.
 * `attributesFor` is the only thing that builds them, so the vocabulary and the producer cannot
 * drift apart.
 */
export const API_POLICY_ATTRIBUTES = [
  'consumerId',
  'consumerKind',
  'consumerStatus',
  'consumerEnvironment',
  'organizationId',
  'planId',
  'daysSinceReview',
  'hasCredentials',

  'apiId',
  'apiVersion',
  'apiMajorVersion',
  'apiLifecycle',
  'apiClassification',
  'apiEnvironment',
  'apiDomain',
  'authentication',

  'operationId',
  'method',
  'operationClassification',
  'operationIdempotent',
  'operationDeprecated',

  'entitlementExpiresInDays',
  'quotaConsumedFraction',
  'inQuotaOverage',
  'rateRemaining',

  'hourUtc',
  'dayOfWeekUtc',
] as const;

export type ApiPolicyAttribute = (typeof API_POLICY_ATTRIBUTES)[number];

export interface ApiPolicyContext {
  readonly consumer: Consumer;
  readonly api: ApiDefinition;
  readonly operation: ApiOperation;
  readonly entitlement: Entitlement | null;
  readonly at: Date;
  readonly quotaConsumedFraction?: number;
  readonly inQuotaOverage?: boolean;
  readonly rateRemaining?: number;
}

/**
 * Build the attributes for one call.
 *
 * Everything here is a scalar. A policy language that can traverse a structure is a policy language
 * that needs a debugger, and the whole value of a decision log is that a reader can look at thirty
 * flat values and re-derive the answer.
 */
export function attributesFor(context: ApiPolicyContext): PolicyAttributes {
  const { consumer, api, operation, entitlement, at } = context;

  const lastReviewed = consumer.lastReviewedAt ?? consumer.createdAt;

  return {
    consumerId: consumer.consumerId,
    consumerKind: consumer.kind,
    consumerStatus: consumer.status,
    consumerEnvironment: consumer.environment,
    organizationId: consumer.organizationId,
    planId: consumer.planId,
    daysSinceReview: Math.floor((at.getTime() - Date.parse(lastReviewed)) / 86_400_000),
    hasCredentials: consumer.credentialIds.length > 0,

    apiId: api.apiId,
    apiVersion: api.version,
    apiMajorVersion: Number(api.version.split('.')[0]),
    apiLifecycle: api.lifecycle,
    apiClassification: apiClassification(api),
    apiEnvironment: api.environment,
    apiDomain: api.domain,
    authentication: api.authentication,

    operationId: operation.operationId,
    method: operation.method,
    operationClassification: operation.classification,
    operationIdempotent: operation.idempotent,
    operationDeprecated: operation.deprecated,

    entitlementExpiresInDays:
      entitlement?.expiresAt == null
        ? null
        : Math.floor((Date.parse(entitlement.expiresAt) - at.getTime()) / 86_400_000),

    quotaConsumedFraction: context.quotaConsumedFraction ?? null,
    inQuotaOverage: context.inQuotaOverage ?? null,
    rateRemaining: context.rateRemaining ?? null,

    hourUtc: at.getUTCHours(),
    dayOfWeekUtc: at.getUTCDay(),
  };
}

/**
 * Reject a policy that reads an attribute this package never supplies.
 *
 * The failure mode is quiet: the rule simply never matches, so the policy looks correct in review
 * and permits everything the author meant it to refuse.
 */
export function assertReadableAttributes(policy: PolicyDocument): void {
  const known = new Set<string>(API_POLICY_ATTRIBUTES);
  const unknown = new Set<string>();

  const walk = (condition: unknown): void => {
    if (typeof condition !== 'object' || condition === null) return;
    const node = condition as Record<string, unknown>;

    if (typeof node.field === 'string' && !known.has(node.field)) unknown.add(node.field);
    for (const key of ['all', 'any', 'not'] as const) {
      const branch = node[key];
      if (Array.isArray(branch)) branch.forEach(walk);
      else if (branch) walk(branch);
    }
  };

  for (const rule of policy.rules) walk(rule.when);

  if (unknown.size > 0) {
    throw ApiError.validation(
      [...unknown].map((field) => ({
        path: `rules.when.${field}`,
        message: `No API call supplies "${field}", so a rule reading it never fires.`,
      })),
      `${policy.policyId} reads attributes the API layer does not supply.`,
    );
  }
}

/**
 * Evaluate the API policies for one call.
 *
 * Every policy is evaluated and **the first denial wins**, rather than the first decision. A policy
 * that allowed could otherwise mask a later one that refused, purely through registration order —
 * and registration order is not something anybody reviews.
 */
export function decideApiPolicy(input: {
  policies: readonly PolicyDocument[];
  context: ApiPolicyContext;
}): { allowed: boolean; decisions: PolicyDecision[]; refusedBy: PolicyDecision | null } {
  const attributes = attributesFor(input.context);
  const decisions = input.policies.map((policy) => evaluatePolicy(policy, attributes));
  const refusedBy = decisions.find((decision) => decision.decision === 'DENY') ?? null;

  return { allowed: refusedBy === null, decisions, refusedBy };
}

export function assertApiPolicy(input: {
  policies: readonly PolicyDocument[];
  context: ApiPolicyContext;
}): PolicyDecision[] {
  const { allowed, decisions, refusedBy } = decideApiPolicy(input);
  if (allowed) return decisions;

  throw ApiError.forbidden((refusedBy as PolicyDecision).reasons.join(' '), {
    reason: 'api_policy_denied',
    policyId: refusedBy?.policyId,
    policyVersion: refusedBy?.policyVersion,
    ruleId: refusedBy?.ruleId,
  });
}

/**
 * A starter policy: a consumer may not reach data above the ceiling for its kind.
 *
 * The same rule `reviewConsumer` reports as a finding, expressed as an enforcement point. Both
 * exist deliberately: the review catches it during a periodic look, the policy catches it on the
 * call, and a deployment that has not yet run a review is still protected.
 *
 * It is a template rather than a fixture — a deployment adjusts the ceilings and re-approves it
 * through the registry like any other policy.
 */
export function classificationCeilingPolicy(input: {
  version?: string;
  owner: string;
  effectiveDate: string;
  reviewDate: string;
}): PolicyDocument {
  const rules = (
    ['developer', 'external_organization', 'partner', 'merchant', 'service_account'] as const
  ).map((kind, index) => ({
    ruleId: `deny-above-ceiling-${kind.replace(/_/g, '-')}`,
    description: `A ${kind} consumer does not reach data above ${KIND_CEILINGS[kind].maxClassification}.`,
    priority: 10 + index,
    when: {
      all: [
        { field: 'consumerKind', operator: 'eq' as const, value: kind },
        {
          field: 'operationClassification',
          operator: 'in' as const,
          value: aboveCeiling(KIND_CEILINGS[kind].maxClassification),
        },
      ],
    },
    effect: 'deny' as const,
    reason: `A ${kind} consumer reaches ${KIND_CEILINGS[kind].maxClassification} data at most.`,
  }));

  return policyDocumentSchema.parse({
    policyId: 'api.classification-ceiling',
    name: 'API classification ceiling',
    description:
      'Refuses a call when the operation returns data above the ceiling for the consumer kind, on the call rather than at the next review.',
    category: 'api',
    version: input.version ?? '1.0.0',
    owner: input.owner,
    status: 'draft',
    rules: [
      ...rules,
      {
        ruleId: 'allow-within-ceiling',
        description: 'Anything at or below the ceiling for the consumer kind proceeds.',
        priority: 900,
        when: { field: 'consumerId', operator: 'exists' as const },
        effect: 'allow' as const,
        reason: 'The operation returns data within the ceiling for this consumer kind.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      {
        name: 'a developer consumer reading confidential data',
        attributes: {
          consumerKind: 'developer',
          operationClassification: 'CONFIDENTIAL',
          consumerId: 'con_dev',
        },
        expect: 'deny',
      },
      {
        name: 'a partner reading confidential data',
        attributes: {
          consumerKind: 'partner',
          operationClassification: 'CONFIDENTIAL',
          consumerId: 'con_partner',
        },
        expect: 'allow',
      },
      {
        name: 'a partner reading restricted data',
        attributes: {
          consumerKind: 'partner',
          operationClassification: 'RESTRICTED',
          consumerId: 'con_partner',
        },
        expect: 'deny',
      },
    ],
    effectiveDate: input.effectiveDate,
    reviewDate: input.reviewDate,
  });
}

const CLASSIFICATION_ORDER = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'HIGHLY_RESTRICTED',
] as const;

function aboveCeiling(ceiling: string): string[] {
  return CLASSIFICATION_ORDER.slice(
    CLASSIFICATION_ORDER.indexOf(ceiling as never) + 1,
  ) as unknown as string[];
}

/**
 * A starter policy: a deprecated operation is refused to a consumer who has had time to move.
 *
 * Expresses a deprecation as enforcement with a grace period rather than as a cliff on the
 * retirement date. A cliff means every unmoved consumer breaks in the same minute, which is how a
 * retirement gets rolled back and the deprecation loses its meaning.
 */
export function deprecationGracePolicy(input: {
  owner: string;
  effectiveDate: string;
  reviewDate: string;
  version?: string;
}): PolicyDocument {
  return policyDocumentSchema.parse({
    policyId: 'api.deprecation-grace',
    name: 'API deprecation grace',
    description:
      'Permits a deprecated operation while the consumer is recently reviewed, and refuses it once nobody has looked in a long time.',
    category: 'api',
    version: input.version ?? '1.0.0',
    owner: input.owner,
    status: 'draft',
    rules: [
      {
        ruleId: 'deny-deprecated-unreviewed',
        description:
          'A deprecated operation is refused to a consumer nobody has reviewed in a year.',
        priority: 10,
        when: {
          all: [
            { field: 'operationDeprecated', operator: 'eq', value: true },
            { field: 'daysSinceReview', operator: 'gt', value: 365 },
          ],
        },
        effect: 'deny',
        reason:
          'This operation is deprecated and this consumer has not been reviewed in over a year. Contact the API owner to migrate.',
      },
      {
        ruleId: 'allow-otherwise',
        description: 'Everything else proceeds; the floor in code has already decided entitlement.',
        priority: 900,
        when: { field: 'operationId', operator: 'exists' },
        effect: 'allow',
        reason: 'Not a deprecated operation, or the consumer is under active review.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      {
        name: 'a deprecated operation for a long-unreviewed consumer',
        attributes: {
          operationDeprecated: true,
          daysSinceReview: 400,
          operationId: 'listMerchants',
        },
        expect: 'deny',
      },
      {
        name: 'a deprecated operation for a recently reviewed consumer',
        attributes: {
          operationDeprecated: true,
          daysSinceReview: 30,
          operationId: 'listMerchants',
        },
        expect: 'allow',
      },
    ],
    effectiveDate: input.effectiveDate,
    reviewDate: input.reviewDate,
  });
}
