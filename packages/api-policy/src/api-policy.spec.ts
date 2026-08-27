import { describe, expect, it } from 'vitest';
import { apiDefinitionSchema } from '@trustos/api-catalog';
import { consumerSchema } from '@trustos/api-consumer';
import { policyDocumentSchema } from '@trustos/policy-registry';
import { evaluatePolicy, runPolicyTests } from '@trustos/policy-evaluator';
import {
  API_POLICY_ATTRIBUTES,
  assertApiPolicy,
  assertReadableAttributes,
  attributesFor,
  classificationCeilingPolicy,
  decideApiPolicy,
  deprecationGracePolicy,
} from './index';

const NOW = new Date('2026-06-01T14:00:00.000Z');

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'listMerchants',
    method: 'GET',
    path: '/api/merchants',
    summary: 'Lists the merchants in the calling organization.',
    scopes: ['merchants:read'],
    classification: 'CONFIDENTIAL',
    idempotent: true,
    deprecated: false,
    ...overrides,
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return apiDefinitionSchema.parse({
    apiId: 'merchant.api',
    name: 'Merchant API',
    description: 'Registration, verification and profile management for merchants.',
    version: '1.2.0',
    domain: 'merchant',
    environment: 'production',
    lifecycle: 'PUBLISHED',
    businessOwnerId: 'usr_business',
    technicalOwnerId: 'usr_tech',
    authentication: 'api_key',
    scopes: ['merchants:read'],
    operations: [operation()],
    openApiRef: 'specs/merchant-api.yaml',
    serviceId: 'merchant.api',
    sloId: 'merchant.api.availability',
    approvedBy: 'usr_governance',
    approvedAt: '2026-02-01T00:00:00.000Z',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function consumer(overrides: Record<string, unknown> = {}) {
  return consumerSchema.parse({
    consumerId: 'con_partner_a',
    name: 'Partner A',
    kind: 'partner',
    description: 'An onboarding partner that reconciles merchant records against its own system.',
    organizationId: 'org_platform',
    environment: 'production',
    entitlements: [
      {
        apiId: 'merchant.api',
        majorVersion: 1,
        scopes: ['merchants:read'],
        grantedBy: 'usr_governance',
        grantedAt: '2026-01-15T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
        justification:
          'The partner reconciles merchant records against their own onboarding system nightly.',
      },
    ],
    credentialIds: ['key_001'],
    planId: 'plan_partner',
    status: 'active',
    ownerId: 'usr_partnerships',
    technicalContact: 'integrations@partner-a.example',
    createdAt: '2026-01-15T00:00:00.000Z',
    lastReviewedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  });
}

function context(overrides: Record<string, unknown> = {}) {
  const definition = (overrides.api as ReturnType<typeof api>) ?? api();
  const subject = (overrides.consumer as ReturnType<typeof consumer>) ?? consumer();

  return {
    consumer: subject,
    api: definition,
    operation: definition.operations[0] as ReturnType<typeof operation>,
    entitlement: subject.entitlements[0] ?? null,
    at: NOW,
    ...overrides,
  };
}

const starterInput = {
  owner: 'usr_platform',
  effectiveDate: '2026-01-01T00:00:00.000Z',
  reviewDate: '2026-12-31T00:00:00.000Z',
};

describe('the attributes a policy may read', () => {
  it('are all scalars', () => {
    /*
     * A policy language that traverses structures needs a debugger. The value of a decision log is
     * that a reader looks at thirty flat values and re-derives the answer.
     */
    const attributes = attributesFor(context());

    for (const value of Object.values(attributes)) {
      expect(['string', 'number', 'boolean', 'object']).toContain(typeof value);
      if (typeof value === 'object') expect(value).toBeNull();
    }
  });

  it('derive the API classification rather than trusting the label', () => {
    const attributes = attributesFor(
      context({ api: api({ operations: [operation({ classification: 'RESTRICTED' })] }) }),
    );

    expect(attributes.apiClassification).toBe('RESTRICTED');
  });

  it('include how long the entitlement has left', () => {
    expect(attributesFor(context()).entitlementExpiresInDays).toBe(29);
  });

  it('cover the declared vocabulary exactly', () => {
    // The producer and the vocabulary cannot drift apart if a test compares them.
    expect(Object.keys(attributesFor(context())).sort()).toEqual([...API_POLICY_ATTRIBUTES].sort());
  });
});

describe('refusing a policy that reads nothing', () => {
  it('rejects an attribute no call supplies', () => {
    /*
     * The quiet failure. The rule never matches, so the policy looks correct in review and permits
     * everything its author meant it to refuse.
     */
    const typo = policyDocumentSchema.parse({
      policyId: 'api.typo',
      name: 'Typo policy',
      description: 'Refuses a call from a consumer whose type is developer, spelled wrongly.',
      category: 'api',
      version: '1.0.0',
      owner: 'usr_platform',
      status: 'draft',
      rules: [
        {
          ruleId: 'deny-developer',
          description: 'Refuses a developer consumer, reading a field that does not exist.',
          priority: 10,
          when: { field: 'consumerType', operator: 'eq', value: 'developer' },
          effect: 'deny',
          reason: 'A developer consumer does not reach this API.',
        },
        {
          ruleId: 'allow-otherwise',
          description: 'Everything else proceeds.',
          priority: 900,
          when: { field: 'consumerId', operator: 'exists' },
          effect: 'allow',
          reason: 'Not a developer consumer.',
        },
      ],
      defaultEffect: 'deny',
      testCases: [
        {
          name: 'a developer',
          attributes: { consumerType: 'developer', consumerId: 'con_dev' },
          expect: 'deny',
        },
        {
          name: 'a partner',
          attributes: { consumerType: 'partner', consumerId: 'con_partner' },
          expect: 'allow',
        },
      ],
      effectiveDate: '2026-01-01T00:00:00.000Z',
      reviewDate: '2026-12-31T00:00:00.000Z',
    });

    try {
      assertReadableAttributes(typo);
      expect.unreachable('should have refused');
    } catch (error) {
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details[0]?.message).toContain('never fires');
    }
  });

  it('accepts the starter policies', () => {
    expect(() => assertReadableAttributes(classificationCeilingPolicy(starterInput))).not.toThrow();
    expect(() => assertReadableAttributes(deprecationGracePolicy(starterInput))).not.toThrow();
  });
});

describe('composing several policies', () => {
  const ceiling = classificationCeilingPolicy(starterInput);
  const grace = deprecationGracePolicy(starterInput);

  it('allows when every policy allows', () => {
    expect(decideApiPolicy({ policies: [ceiling, grace], context: context() }).allowed).toBe(true);
  });

  it('lets the first denial win regardless of registration order', () => {
    /*
     * The composition rule. If the first *decision* won, a permissive policy registered earlier
     * would mask a later refusal — and registration order is not something anybody reviews.
     */
    const denied = context({
      consumer: consumer({ kind: 'developer', environment: 'staging' }),
      api: api({ environment: 'staging', lifecycle: 'PUBLISHED' }),
    });

    const forward = decideApiPolicy({ policies: [grace, ceiling], context: denied });
    const reverse = decideApiPolicy({ policies: [ceiling, grace], context: denied });

    expect(forward.allowed).toBe(false);
    expect(reverse.allowed).toBe(false);
    expect(forward.refusedBy?.policyId).toBe(reverse.refusedBy?.policyId);
  });

  it('throws with the deciding policy and rule attached', () => {
    // What an operator needs to answer "why was I refused" without reading logs.
    const denied = context({
      consumer: consumer({ kind: 'developer', environment: 'staging' }),
      api: api({ environment: 'staging' }),
    });

    try {
      assertApiPolicy({ policies: [ceiling], context: denied });
      expect.unreachable('should have refused');
    } catch (error) {
      const captured = (error as { context?: Record<string, unknown> }).context ?? {};
      expect(captured.policyId).toBe('api.classification-ceiling');
      expect(captured.ruleId).toBe('deny-above-ceiling-developer');
    }
  });
});

describe('the classification ceiling policy', () => {
  const policy = classificationCeilingPolicy(starterInput);

  it('passes its own tests', () => {
    expect(runPolicyTests(policy).passed).toBe(true);
  });

  it('refuses a partner reaching restricted data', () => {
    /*
     * The same thing reviewConsumer reports as a finding, enforced on the call. Both exist: the
     * review catches it periodically, the policy catches it now, and a deployment that has not run
     * a review yet is still protected.
     */
    const decision = evaluatePolicy(
      policy,
      attributesFor(
        context({ api: api({ operations: [operation({ classification: 'RESTRICTED' })] }) }),
      ),
    );

    expect(decision.decision).toBe('DENY');
  });

  it('permits an internal application reaching the same data', () => {
    const internal = context({
      consumer: consumer({ consumerId: 'con_settlement', kind: 'internal_application' }),
      api: api({ operations: [operation({ classification: 'RESTRICTED' })] }),
    });

    expect(evaluatePolicy(policy, attributesFor(internal)).decision).toBe('ALLOW');
  });

  it('defaults to deny', () => {
    // Inherited from the registry schema, and worth confirming at this layer too.
    expect(policy.defaultEffect).toBe('deny');
  });

  it('is produced as a draft, not as something already in force', () => {
    // A starter policy a deployment adjusts and approves through the registry like any other.
    expect(policy.status).toBe('draft');
  });
});

describe('the deprecation grace policy', () => {
  const policy = deprecationGracePolicy(starterInput);

  it('passes its own tests', () => {
    expect(runPolicyTests(policy).passed).toBe(true);
  });

  it('refuses a deprecated operation to a consumer nobody has reviewed', () => {
    const stale = context({
      consumer: consumer({ lastReviewedAt: '2025-01-01T00:00:00.000Z' }),
      api: api({ operations: [operation({ deprecated: true })] }),
    });

    expect(evaluatePolicy(policy, attributesFor(stale)).decision).toBe('DENY');
  });

  it('permits it to a consumer under active review', () => {
    /*
     * A deprecation enforced as a cliff breaks every unmoved consumer in the same minute, which is
     * how a retirement gets rolled back and the deprecation stops meaning anything.
     */
    const reviewed = context({ api: api({ operations: [operation({ deprecated: true })] }) });
    expect(evaluatePolicy(policy, attributesFor(reviewed)).decision).toBe('ALLOW');
  });
});
