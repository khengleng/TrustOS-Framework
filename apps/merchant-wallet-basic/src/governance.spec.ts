import { describe, expect, it } from 'vitest';
import { DataCatalog, catalogEntrySchema } from '@trustsystem/data-catalog';
import { classificationRank, obligationsFor } from '@trustsystem/data-classification';
import { PolicyRegistry, policyDocumentSchema } from '@trustsystem/policy-registry';
import { evaluatePolicy, runPolicyTests } from '@trustsystem/policy-evaluator';
import { InMemoryPolicyDecisionSink, PolicyDecisionLog } from '@trustsystem/policy-decision-log';
import { PolicyEngine } from '@trustsystem/policy-engine';
import { ApiCatalog, apiClassification, apiDefinitionSchema } from '@trustsystem/api-catalog';
import { ConsumerRegistry, consumerSchema } from '@trustsystem/api-consumer';
import { ApiGateway, InMemoryAnalyticsSink, summariseAnalytics } from '@trustsystem/api-management';
import { InMemoryQuotaUsageStore, quotaSchema } from '@trustsystem/api-quota';
import { InMemoryRateCounterStore, rateLimitSchema } from '@trustsystem/api-rate-limit';
import {
  aggregate,
  sliDefinitionSchema,
  sliMeasurementSchema,
  sufficientToJudge,
} from '@trustsystem/sli';
import { burnAlert, burnRate, errorBudget, evaluateSlo, sloSchema } from '@trustsystem/slo';
import { ServiceRegistry, runbookSchema, serviceSchema } from '@trustsystem/sre-core';
import {
  AI_FORBIDDEN_ACTIONS,
  PERMITTED_INPUTS,
  requiresHumanReview,
} from '@trustsystem/governance-ai-bridge';

/**
 * §11 and §15–§20 of the pilot specification: the enterprise layer applied to the pilot.
 *
 * Data governance, policy-as-code, API management, observability, objectives and the AI assistant
 * — each configured for Merchant Wallet Basic and exercised. Every one of them is framework; what
 * the pilot supplies is the configuration, and the configuration is what a deployment writes.
 *
 * The classifications the specification asks for are the interesting part, because getting them
 * wrong is invisible: a merchant profile classified INTERNAL rather than CONFIDENTIAL reads
 * perfectly reasonably and removes masking from every field on it.
 */

const NOW = new Date('2026-06-15T10:00:00.000Z');

// --- §16 data governance -----------------------------------------------------

function entry(overrides: Record<string, unknown> = {}) {
  return catalogEntrySchema.parse({
    entryId: 'mwb.merchant',
    kind: 'table',
    technicalName: 'merchants',
    businessName: 'Merchant profile',
    description: 'Registered merchants, their status, category and contact details.',
    parentId: null,
    owner: 'usr_merchant_ops',
    steward: 'usr_data_gov',
    businessDomain: 'merchant',
    classification: 'CONFIDENTIAL',
    personalData: true,
    environment: 'prod',
    residencyRegion: 'eu-west',
    purpose: 'Operating merchant accounts and answering support enquiries.',
    legalBasis: 'Contract',
    lastReviewDate: '2026-01-01T00:00:00.000Z',
    nextReviewDate: '2026-12-01T00:00:00.000Z',
    ...overrides,
  });
}

/** The pilot's catalog, at the classifications the specification asks for. */
function pilotCatalog(): DataCatalog {
  return new DataCatalog([
    entry(),
    entry({
      entryId: 'mwb.wallet',
      technicalName: 'wallets',
      businessName: 'Merchant wallet',
      description: 'Wallet balances and held amounts, one per merchant per currency.',
      classification: 'RESTRICTED',
      personalData: false,
      businessDomain: 'financial',
      purpose: 'Holding merchant proceeds between acceptance and settlement.',
    }),
    entry({
      entryId: 'mwb.transaction',
      technicalName: 'payments',
      businessName: 'Financial transaction',
      description: 'Accepted payments with their gross, fee and net amounts.',
      classification: 'RESTRICTED',
      personalData: false,
      businessDomain: 'financial',
      purpose: 'Recording what was accepted, for settlement and dispute handling.',
    }),
    entry({
      entryId: 'mwb.ledger',
      technicalName: 'journals',
      businessName: 'Ledger journal',
      description: 'Double-entry journals behind every accepted payment.',
      classification: 'HIGHLY_RESTRICTED',
      personalData: false,
      businessDomain: 'financial',
      purpose: 'The authoritative record of what money moved.',
    }),
    entry({
      entryId: 'mwb.audit',
      technicalName: 'audit_log',
      businessName: 'Audit trail',
      description: 'Every consequential action taken in the application.',
      classification: 'HIGHLY_RESTRICTED',
      personalData: true,
      businessDomain: 'governance',
      purpose: 'Evidence of who did what, for investigation and regulatory response.',
    }),
    entry({
      entryId: 'mwb.product_docs',
      kind: 'document_type',
      technicalName: 'product_documentation',
      businessName: 'Public product documentation',
      description: 'The published description of what Merchant Wallet Basic does.',
      classification: 'PUBLIC',
      personalData: false,
      businessDomain: 'product',
      purpose: 'Telling prospective merchants what the product does.',
    }),
  ]);
}

describe('data governance', () => {
  it('classifies the six entities the specification names', () => {
    const catalog = pilotCatalog();

    expect(catalog.require('mwb.merchant').classification).toBe('CONFIDENTIAL');
    expect(catalog.require('mwb.wallet').classification).toBe('RESTRICTED');
    expect(catalog.require('mwb.transaction').classification).toBe('RESTRICTED');
    expect(catalog.require('mwb.ledger').classification).toBe('HIGHLY_RESTRICTED');
    expect(catalog.require('mwb.audit').classification).toBe('HIGHLY_RESTRICTED');
    expect(catalog.require('mwb.product_docs').classification).toBe('PUBLIC');
  });

  it('masks the merchant profile and the wallet by default', () => {
    // From the classification, not from a field list somebody maintains.
    expect(obligationsFor('CONFIDENTIAL').maskByDefault).toBe(true);
    expect(obligationsFor('RESTRICTED').maskByDefault).toBe(true);
    expect(obligationsFor('PUBLIC').maskByDefault).toBe(false);
  });

  it('requires a second person to reveal a wallet balance and refuses to export the ledger', () => {
    expect(obligationsFor('RESTRICTED').revealRequiresApproval).toBe(true);
    expect(obligationsFor('HIGHLY_RESTRICTED').exportable).toBe(false);
  });

  it('keeps the ledger out of AI inputs', () => {
    // HIGHLY_RESTRICTED is not an AI input at any classification level.
    expect(obligationsFor('HIGHLY_RESTRICTED').aiInputPermitted).toBe(false);
    expect(obligationsFor('RESTRICTED').aiInputPermitted).toBe(true);
  });

  it('narrows an unauthorized catalog search to a stub', () => {
    const stub = pilotCatalog().search({ authorized: false })[0] as Record<string, unknown>;

    expect(stub.entryId).toBeDefined();
    expect(stub.purpose).toBeUndefined();
    expect(stub.residencyRegion).toBeUndefined();
  });

  it('finds nothing misclassified', () => {
    expect(pilotCatalog().misclassified()).toEqual([]);
  });

  it('would catch the wallet classified below the ledger it derives from', () => {
    /*
     * The mistake worth catching. A wallet table classified INTERNAL reads reasonably — it is a
     * balance, not a payment — and removes masking from a figure the ledger protects.
     */
    const understated = new DataCatalog([
      entry({ entryId: 'mwb.wallet', classification: 'INTERNAL', personalData: false }),
      entry({
        entryId: 'mwb.wallet.balance',
        kind: 'column',
        parentId: 'mwb.wallet',
        technicalName: 'balance_minor_units',
        businessName: 'Wallet balance',
        classification: 'RESTRICTED',
        personalData: false,
      }),
    ]);

    expect(understated.misclassified()).toHaveLength(1);
  });
});

// --- §17 policy-as-code ------------------------------------------------------

function policy(overrides: Record<string, unknown> = {}) {
  return policyDocumentSchema.parse({
    policyId: 'mwb.merchant-approval',
    name: 'Merchant approval',
    description:
      'Decides whether a merchant may be approved, given who verified it and its category.',
    category: 'financial',
    version: '1.0.0',
    owner: 'usr_policy_author',
    status: 'active',
    rules: [
      {
        ruleId: 'deny-self-approval',
        description: 'The person who verified a merchant does not approve it.',
        priority: 10,
        when: { field: 'approverIsVerifier', operator: 'eq', value: true },
        effect: 'deny',
        reason: 'Maker and checker are different people.',
      },
      {
        ruleId: 'deny-unverified',
        description: 'A merchant nobody verified cannot be approved.',
        priority: 20,
        when: { field: 'verified', operator: 'eq', value: false },
        effect: 'deny',
        reason: 'Approval is a check on verification work that has not been done.',
      },
      {
        ruleId: 'allow-verified',
        description: 'A verified merchant approved by a second person proceeds.',
        priority: 90,
        when: { field: 'verified', operator: 'eq', value: true },
        effect: 'allow',
        reason: 'Verified, and approved by somebody other than the verifier.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      {
        name: 'the verifier approving',
        attributes: { approverIsVerifier: true, verified: true },
        expect: 'deny',
      },
      {
        name: 'unverified',
        attributes: { approverIsVerifier: false, verified: false },
        expect: 'deny',
      },
      {
        name: 'verified, second person',
        attributes: { approverIsVerifier: false, verified: true },
        expect: 'allow',
      },
    ],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  });
}

function engine(policies = [policy()]) {
  let counter = 0;
  const sink = new InMemoryPolicyDecisionSink();

  return {
    sink,
    engine: new PolicyEngine({
      registry: new PolicyRegistry(policies),
      log: new PolicyDecisionLog(sink),
      supportedObligations: [],
      newDecisionId: () => `dec_${(counter += 1)}`,
      now: () => NOW,
    }),
  };
}

describe('policy-as-code', () => {
  it('passes its own tests', () => {
    expect(runPolicyTests(policy()).passed).toBe(true);
  });

  it('allows a verified merchant approved by a second person', async () => {
    const { engine: policyEngine } = engine();

    const decision = await policyEngine.decide({
      policyId: 'mwb.merchant-approval',
      attributes: { approverIsVerifier: false, verified: true },
      actorId: 'usr_ops_manager',
      organizationId: 'org_a',
      action: 'mwb.merchant.approve',
      correlationId: 'cor_policy_allow',
    });

    expect(decision.decision).toBe('ALLOW');
  });

  it('denies the verifier approving their own work', async () => {
    const { engine: policyEngine } = engine();

    const decision = await policyEngine.decide({
      policyId: 'mwb.merchant-approval',
      attributes: { approverIsVerifier: true, verified: true },
      actorId: 'usr_ops_checker',
      organizationId: 'org_a',
      action: 'mwb.merchant.approve',
      correlationId: 'cor_policy_deny',
    });

    expect(decision.decision).toBe('DENY');
    expect(decision.reasons.join(' ')).toContain('different people');
  });

  it('defaults to deny', () => {
    // Nothing matches, so nothing is permitted. The schema refuses any other default.
    expect(evaluatePolicy(policy(), {}).decision).toBe('DENY');
    expect(policy().defaultEffect).toBe('deny');
  });

  it('records both the allow and the deny', async () => {
    /*
     * A decision point that logged only denials answers "what did we refuse" and not "what did we
     * permit", and the second is the question asked about a breach.
     */
    const { engine: policyEngine, sink } = engine();

    await policyEngine.decide({
      policyId: 'mwb.merchant-approval',
      attributes: { approverIsVerifier: false, verified: true },
      actorId: 'usr_a',
      organizationId: 'org_a',
      action: 'mwb.merchant.approve',
      correlationId: 'cor_1',
    });
    await policyEngine.decide({
      policyId: 'mwb.merchant-approval',
      attributes: { approverIsVerifier: true, verified: true },
      actorId: 'usr_b',
      organizationId: 'org_a',
      action: 'mwb.merchant.approve',
      correlationId: 'cor_2',
    });

    expect(sink.records).toHaveLength(2);
    expect(sink.records.map((record) => record.decision).sort()).toEqual(['ALLOW', 'DENY']);
  });

  it('refuses to enforce a draft', async () => {
    const { engine: policyEngine } = engine([policy({ status: 'draft' })]);

    await expect(
      policyEngine.decide({
        policyId: 'mwb.merchant-approval',
        policyVersion: '1.0.0',
        attributes: { approverIsVerifier: false, verified: true },
        actorId: 'usr_a',
        organizationId: 'org_a',
        action: 'mwb.merchant.approve',
        correlationId: 'cor_draft',
      }),
    ).rejects.toThrow(/cannot decide/);
  });

  it('records the policy version, so the decision can be re-derived', async () => {
    const { engine: policyEngine, sink } = engine();

    await policyEngine.decide({
      policyId: 'mwb.merchant-approval',
      attributes: { approverIsVerifier: false, verified: true },
      actorId: 'usr_a',
      organizationId: 'org_a',
      action: 'mwb.merchant.approve',
      correlationId: 'cor_version',
    });

    expect(sink.records[0]?.policyVersion).toBe('1.0.0');
  });
});

// --- §18 API management ------------------------------------------------------

function api(overrides: Record<string, unknown> = {}) {
  return apiDefinitionSchema.parse({
    apiId: 'mwb.payments',
    name: 'Merchant Wallet Basic — payments',
    description: 'Accepts payments for an approved merchant and reports what was accepted.',
    version: '1.0.0',
    domain: 'financial',
    environment: 'production',
    lifecycle: 'PUBLISHED',
    businessOwnerId: 'usr_product',
    technicalOwnerId: 'usr_platform',
    authentication: 'api_key',
    scopes: ['payments:write'],
    operations: [
      {
        operationId: 'acceptPayment',
        method: 'POST',
        path: '/api/payments',
        summary: 'Accepts a payment for an approved merchant.',
        scopes: ['payments:write'],
        classification: 'RESTRICTED',
        // Idempotent on the merchant's own reference — see domain/payment.ts.
        idempotent: true,
      },
      {
        operationId: 'getPayment',
        method: 'GET',
        path: '/api/payments/:paymentId',
        summary: 'Reads one accepted payment.',
        scopes: ['payments:read'],
        classification: 'RESTRICTED',
        idempotent: true,
      },
    ],
    openApiRef: 'docs/pilot/evidence/mwb-payments-1.0.0.yaml',
    serviceId: 'mwb.api',
    sloId: 'mwb.api.availability',
    approvedBy: 'usr_governance',
    approvedAt: '2026-02-01T00:00:00.000Z',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function consumer(overrides: Record<string, unknown> = {}) {
  return consumerSchema.parse({
    consumerId: 'con_alpha_pos',
    name: 'Alpha Coffee point of sale',
    kind: 'merchant',
    description: 'The point-of-sale integration at Alpha Coffee, taking payments at its branches.',
    organizationId: 'org_a',
    environment: 'production',
    entitlements: [
      {
        apiId: 'mwb.payments',
        majorVersion: 1,
        scopes: ['payments:write'],
        grantedBy: 'usr_governance',
        grantedAt: '2026-01-15T00:00:00.000Z',
        expiresAt: '2027-01-15T00:00:00.000Z',
        justification: 'The point-of-sale takes payments at the merchant’s own branches.',
      },
    ],
    credentialIds: ['key_alpha'],
    planId: 'plan_merchant',
    status: 'active',
    ownerId: 'usr_partnerships',
    technicalContact: 'tech@alpha-coffee.example',
    createdAt: '2026-01-15T00:00:00.000Z',
    lastReviewedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  });
}

function gateway(overrides: Record<string, unknown> = {}) {
  const analytics = new InMemoryAnalyticsSink();

  const gate = new ApiGateway({
    catalog: new ApiCatalog([api()]),
    consumers: new ConsumerRegistry([consumer()]),
    rateLimits: [
      rateLimitSchema.parse({
        limitId: 'rl.mwb.consumer',
        scope: 'consumer',
        apiId: 'mwb.payments',
        limit: 5,
        unit: 'minute',
        description: 'The sustained rate for a merchant point-of-sale integration.',
      }),
    ],
    rateStore: new InMemoryRateCounterStore(),
    quotaFor: () =>
      quotaSchema.parse({
        quotaId: 'q.alpha.monthly',
        scope: 'consumer',
        subjectId: 'con_alpha_pos',
        apiId: 'mwb.payments',
        period: 'monthly',
        resetDayOfMonth: 1,
        limit: 3,
        description: 'The monthly call allowance in the merchant plan.',
      }),
    quotaStore: new InMemoryQuotaUsageStore(),
    analytics,
    ...overrides,
  });

  return { gate, analytics };
}

function call(overrides: Record<string, unknown> = {}) {
  return {
    apiId: 'mwb.payments',
    version: '1.0.0',
    method: 'POST',
    path: '/api/payments',
    consumerId: 'con_alpha_pos',
    at: NOW,
    correlationId: 'cor_api',
    ...overrides,
  };
}

describe('API management', () => {
  it('registers the pilot API with owners, classification and an objective', () => {
    const definition = api();

    expect(apiClassification(definition)).toBe('RESTRICTED');
    expect(definition.businessOwnerId).not.toBe(definition.technicalOwnerId);
    expect(definition.sloId).toBe('mwb.api.availability');
  });

  it('admits an authorized consumer', async () => {
    const { gate } = gateway();
    expect((await gate.check(call())).allowed).toBe(true);
  });

  it('refuses an unauthorized consumer', async () => {
    const { gate } = gateway();
    expect((await gate.check(call({ consumerId: 'con_unknown' }))).reasonCode).toBe(
      'consumer_not_registered',
    );
  });

  it('lets a write scope read, and not the reverse', async () => {
    /*
     * `@trustsystem/api-keys`' rule, reused rather than restated: a credential that may change
     * something can necessarily observe it. The pilot's first version of this test asserted the
     * opposite and was wrong — requiring both scopes on every credential is how every credential
     * eventually gets a wildcard.
     */
    const { gate } = gateway();

    const read = await gate.check(
      call({ method: 'GET', path: '/api/payments/pay_1', correlationId: 'cor_read' }),
    );
    expect(read.allowed).toBe(true);

    const readOnly = gateway({
      consumers: new ConsumerRegistry([
        consumer({
          entitlements: [
            {
              apiId: 'mwb.payments',
              majorVersion: 1,
              scopes: ['payments:read'],
              grantedBy: 'usr_governance',
              grantedAt: '2026-01-15T00:00:00.000Z',
              expiresAt: '2027-01-15T00:00:00.000Z',
              justification: 'A reporting integration that reads accepted payments nightly.',
            },
          ],
        }),
      ]),
    });

    const write = await readOnly.gate.check(call({ correlationId: 'cor_write' }));
    expect(write.reasonCode).toBe('scope_not_granted');
  });

  it('refuses above the rate limit', async () => {
    const { gate } = gateway();

    for (let index = 0; index < 5; index += 1) await gate.check(call());
    expect((await gate.check(call())).refusedAt).toBe('rate');
  });

  it('refuses once the quota is used up', async () => {
    const { gate } = gateway();

    for (let index = 0; index < 3; index += 1) await gate.check(call());
    expect((await gate.check(call())).refusedAt).toBe('quota');
  });

  it('refuses a version the consumer is not entitled to', async () => {
    const { gate } = gateway({ catalog: new ApiCatalog([api({ version: '2.0.0' })]) });

    expect((await gate.check(call({ version: '2.0.0' }))).reasonCode).toBe('no_entitlement');
  });

  it('counts refusals in the analytics', async () => {
    const { gate, analytics } = gateway();

    await gate.check(call());
    await gate.check(call({ consumerId: 'con_unknown' }));

    const summary = summariseAnalytics(analytics.entries);
    expect(summary.totalRequests).toBe(2);
    expect(summary.refused).toBe(1);
  });
});

// --- §19 observability, §20 SLO ---------------------------------------------

describe('observability and objectives', () => {
  const runbook = runbookSchema.parse({
    runbookId: 'rb.mwb.payments-failing',
    title: 'Payments failing',
    trigger: 'The payment success indicator falls below 99% over fifteen minutes.',
    severityHint: 'SEV1',
    steps: [
      {
        title: 'Establish whether the ledger is refusing',
        action:
          'Check the refusal codes on recent payments; ledger_refused points at the database.',
        verification: 'The refusal distribution names a single dominant code.',
      },
    ],
    escalateTo: 'Platform on-call, then the payments product owner.',
    lastReviewedAt: '2026-05-01T00:00:00.000Z',
    ownerId: 'usr_platform',
  });

  const service = serviceSchema.parse({
    serviceId: 'mwb.api',
    name: 'Merchant Wallet Basic API',
    description: 'Accepts merchant payments and posts them to the ledger.',
    tier: 'tier_1',
    ownerTeam: 'payments',
    onCallRotation: 'payments-primary',
    runbookIds: ['rb.mwb.payments-failing'],
    supportsProducts: ['merchant-wallet-basic'],
    environment: 'production',
    registeredAt: '2026-01-01T00:00:00.000Z',
    dependencies: [
      {
        dependencyId: 'ledger',
        kind: 'database',
        description: 'Posts a journal for every accepted payment.',
        critical: true,
        targetServiceId: null,
        degradedBehaviour: 'Payments are refused rather than accepted without a journal.',
        runbookId: 'rb.mwb.payments-failing',
      },
    ],
  });

  const indicator = sliDefinitionSchema.parse({
    sliId: 'mwb.api.payment_success',
    serviceId: 'mwb.api',
    kind: 'payment_processing_success',
    name: 'Payment processing success',
    goodEventDefinition:
      'A payment request that was accepted, or refused for a stated business reason such as a limit.',
    validEventDefinition:
      'Every authenticated payment request, excluding those the gateway refused before reaching the product.',
    source: 'the payment engine’s own result records',
  });

  const objective = sloSchema.parse({
    sloId: 'mwb.api.payment_success',
    serviceId: 'mwb.api',
    sliId: 'mwb.api.payment_success',
    name: 'Payment processing success',
    target: 99.9,
    windowDays: 30,
    // A pilot objective. Measured and reported, and explicitly not a commitment.
    status: 'pilot',
    ownerTeam: 'payments',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  });

  it('registers the pilot service with an owner, a rotation and a runbook', () => {
    const registry = new ServiceRegistry({ runbooks: [runbook], services: [service] });

    expect(registry.require('mwb.api').tier).toBe('tier_1');
    expect(registry.runbooksFor('mwb.api')).toHaveLength(1);
    expect(registry.analyse()).toEqual([]);
  });

  it('measures the objective against a window with enough traffic', () => {
    /*
     * The measurement is from the 100,000-transaction simulation: 93,207 successes and 3,416
     * business refusals count as good; 1,378 failures do not.
     */
    const value = aggregate([
      sliMeasurementSchema.parse({
        sliId: 'mwb.api.payment_success',
        windowStart: '2026-06-01T00:00:00.000Z',
        windowEnd: '2026-06-30T00:00:00.000Z',
        goodEvents: 93_207 + 3_416,
        validEvents: 98_001,
      }),
    ]);

    const status = evaluateSlo(
      objective,
      value,
      sufficientToJudge(value, { objectivePercentage: objective.target }),
    );

    // 96,623 of 98,001 is 98.59% — below the 99.9% target, which is what the failures cost.
    expect(status.verdict).toBe('missed');
    expect(status.measured).toBeLessThan(objective.target);
    expect(status.isCommitment).toBe(false);
  });

  it('calculates the error budget from the same numbers', () => {
    const value = aggregate([
      sliMeasurementSchema.parse({
        sliId: 'mwb.api.payment_success',
        windowStart: '2026-06-01T00:00:00.000Z',
        windowEnd: '2026-06-30T00:00:00.000Z',
        goodEvents: 93_207 + 3_416,
        validEvents: 98_001,
      }),
    ]);

    const budget = errorBudget(objective, value);

    // 0.1% of 98,001 is about 98 permitted failures; there were 1,378.
    expect(budget?.allowedBadEvents).toBeCloseTo(98, 0);
    expect(budget?.badEvents).toBe(1_378);
    expect(budget?.state).toBe('exhausted');
    expect(budget?.consumed).toBeGreaterThan(1);
  });

  it('recommends reversible actions rather than halting anything', () => {
    const value = aggregate([
      sliMeasurementSchema.parse({
        sliId: 'mwb.api.payment_success',
        windowStart: '2026-06-01T00:00:00.000Z',
        windowEnd: '2026-06-30T00:00:00.000Z',
        goodEvents: 93_207,
        validEvents: 98_001,
      }),
    ]);

    const budget = errorBudget(objective, value);
    expect(budget?.actions).toContain('require_incident_review');
    expect(budget?.actions).toContain('pause_nonessential_deployment');
  });

  it('pages on a fast burn', () => {
    const value = aggregate([
      sliMeasurementSchema.parse({
        sliId: 'mwb.api.payment_success',
        windowStart: '2026-06-15T09:00:00.000Z',
        windowEnd: '2026-06-15T10:00:00.000Z',
        goodEvents: 900,
        validEvents: 1_000,
      }),
    ]);

    const fast = burnRate({ slo: objective, value, observedHours: 1 });
    expect(burnAlert({ fastBurn: fast, slowBurn: 1 }).severity).toBe('page');
  });

  it('reports an unmeasured window as unmeasured rather than perfect', () => {
    const empty = aggregate([
      sliMeasurementSchema.parse({
        sliId: 'mwb.api.payment_success',
        windowStart: '2026-06-15T03:00:00.000Z',
        windowEnd: '2026-06-15T04:00:00.000Z',
        goodEvents: 0,
        validEvents: 0,
      }),
    ]);

    expect(empty.ratio).toBeNull();
    expect(
      evaluateSlo(objective, empty, sufficientToJudge(empty, { objectivePercentage: 99.9 }))
        .verdict,
    ).toBe('insufficient_data');
  });

  it('names the indicator’s good and valid events, which is the part people argue about', () => {
    expect(indicator.goodEventDefinition).toContain('refused for a stated business reason');
    expect(indicator.validEventDefinition).toContain('excluding');
  });
});

// --- §15 the AI assistant ----------------------------------------------------

describe('the merchant operations assistant', () => {
  it('may not approve a merchant, change a limit, post a journal or execute a payment', () => {
    for (const forbidden of [
      'approve a merchant',
      'modify a limit',
      'post a ledger entry',
      'execute a payment',
      'change a wallet balance',
    ]) {
      expect(AI_FORBIDDEN_ACTIONS).toContain(forbidden);
    }
  });

  it('gets a case reference rather than the customer record', () => {
    /*
     * The way a summarizer becomes an exfiltration path is that somebody widens its inputs "so it
     * has more context". The allow-list makes that a reviewed change rather than a one-line one.
     */
    expect(PERMITTED_INPUTS.summarize_case).toEqual(['caseRef', 'caseTimeline', 'caseComments']);
    expect(PERMITTED_INPUTS.explain_transaction_failure).toEqual([
      'transactionRef',
      'executionSteps',
      'refusalCode',
    ]);
  });

  it('requires a person before a drafted operations note is used', () => {
    expect(requiresHumanReview('draft_investigation_notes')).toBe(true);
  });

  it('does not require one to explain a transaction failure', () => {
    // It restates the refusal code the caller already received.
    expect(requiresHumanReview('explain_transaction_failure')).toBe(false);
  });

  it('is never given the ledger', () => {
    /*
     * Two controls agreeing. The classification says HIGHLY_RESTRICTED is not an AI input, and no
     * feature's allow-list names a ledger input.
     */
    expect(obligationsFor('HIGHLY_RESTRICTED').aiInputPermitted).toBe(false);

    const everyInput = Object.values(PERMITTED_INPUTS).flat();
    expect(everyInput.some((input) => input.toLowerCase().includes('journal'))).toBe(false);
    expect(everyInput.some((input) => input.toLowerCase().includes('ledger'))).toBe(false);
  });

  it('classifies the assistant’s own inputs below the ledger', () => {
    const catalog = pilotCatalog();
    const permitted = ['mwb.merchant', 'mwb.transaction'];

    for (const entryId of permitted) {
      expect(classificationRank(catalog.require(entryId).classification), entryId).toBeLessThan(
        classificationRank('HIGHLY_RESTRICTED'),
      );
    }
  });
});
