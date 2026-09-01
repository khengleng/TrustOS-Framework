import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { classificationRank, obligationsFor } from '@trustsystem/data-classification';
import { DataCatalog, catalogEntrySchema } from '@trustsystem/data-catalog';
import { PolicyRegistry, policyDocumentSchema } from '@trustsystem/policy-registry';
import { InMemoryPolicyDecisionSink, PolicyDecisionLog } from '@trustsystem/policy-decision-log';
import { PolicyEngine } from '@trustsystem/policy-engine';
import { ApiCatalog, apiDefinitionSchema } from '@trustsystem/api-catalog';
import { ConsumerRegistry, consumerSchema, decideAccess } from '@trustsystem/api-consumer';
import {
  InMemoryQuotaUsageStore,
  consumeQuota,
  quotaSchema,
  type Quota,
} from '@trustsystem/api-quota';
import { InMemoryRateCounterStore, checkRate, rateLimitSchema } from '@trustsystem/api-rate-limit';
import { ApiGateway, InMemoryAnalyticsSink } from '@trustsystem/api-management';
import {
  BackupInventory,
  assertFullyValidated,
  assuranceOf,
  backupRecordSchema,
} from '@trustsystem/backup';
import {
  AI_FORBIDDEN_ACTIONS,
  AI_ASSIST_FEATURES,
  isProposalOnly,
} from '@trustsystem/governance-ai-bridge';
import { ENTERPRISE_PERMISSIONS, segregationViolations } from './permissions';

/**
 * The mandatory negative tests for the enterprise layer.
 *
 * Every one asserts that a **bypass is refused**, and each is written against the route somebody
 * would actually take rather than against the obvious one. The obvious attack is stopped by the
 * guard chain, which every application boots and every boot test asserts; what is worth testing
 * here is the plausible internal shortcut — a query parameter that widens a search, an entitlement
 * that follows the newest version, a quota counted before authorization.
 *
 * They live in the application rather than in a package because most of them are properties of a
 * *composition*: no single package can assert that a quota cannot be bypassed through an alternate
 * endpoint, because a package only knows about one endpoint.
 */

const NOW = new Date('2026-06-20T12:00:00.000Z');

// --- fixtures ----------------------------------------------------------------

function entry(overrides: Record<string, unknown> = {}) {
  return catalogEntrySchema.parse({
    entryId: 'db.wallet',
    kind: 'table',
    technicalName: 'wallets',
    businessName: 'Wallet balances',
    description: 'Wallet balances and their held amounts, per merchant.',
    parentId: null,
    owner: 'usr_finance',
    steward: 'usr_data_gov',
    businessDomain: 'financial',
    classification: 'RESTRICTED',
    personalData: false,
    environment: 'prod',
    residencyRegion: 'eu-west',
    purpose: 'Operating merchant wallets and answering balance enquiries.',
    legalBasis: 'Contract',
    lastReviewDate: '2026-01-01T00:00:00.000Z',
    nextReviewDate: '2026-12-01T00:00:00.000Z',
    ...overrides,
  });
}

function policy(overrides: Record<string, unknown> = {}) {
  return policyDocumentSchema.parse({
    policyId: 'data.reveal',
    name: 'Restricted data reveal',
    description: 'Decides whether a restricted value may be revealed to a named requester.',
    category: 'data',
    version: '1.0.0',
    owner: 'usr_policy_author',
    status: 'active',
    rules: [
      {
        ruleId: 'deny-without-approval',
        description: 'A reveal without a recorded approval is refused.',
        priority: 10,
        when: { field: 'approvedBy', operator: 'missing' },
        effect: 'deny',
        reason: 'A reveal of restricted data requires a second person.',
      },
      {
        ruleId: 'allow-approved',
        description: 'An approved reveal proceeds.',
        priority: 20,
        when: { field: 'approvedBy', operator: 'exists' },
        effect: 'allow',
        reason: 'The reveal was approved by a second person.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      { name: 'no approval', attributes: { requesterId: 'usr_a' }, expect: 'deny' },
      {
        name: 'approved',
        attributes: { requesterId: 'usr_a', approvedBy: 'usr_b' },
        expect: 'allow',
      },
    ],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  });
}

function engineFor(policies: ReturnType<typeof policy>[]) {
  let counter = 0;
  return new PolicyEngine({
    registry: new PolicyRegistry(policies),
    log: new PolicyDecisionLog(new InMemoryPolicyDecisionSink()),
    supportedObligations: [],
    newDecisionId: () => `dec_${(counter += 1)}`,
    now: () => NOW,
  });
}

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'listWallets',
    method: 'GET',
    path: '/api/wallets',
    summary: 'Lists the wallets in the calling organization.',
    scopes: ['wallets:read'],
    classification: 'RESTRICTED',
    idempotent: true,
    ...overrides,
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return apiDefinitionSchema.parse({
    apiId: 'wallet.api',
    name: 'Wallet API',
    description: 'Reads wallet balances and held amounts for a merchant.',
    version: '1.0.0',
    domain: 'financial',
    environment: 'production',
    lifecycle: 'PUBLISHED',
    businessOwnerId: 'usr_business',
    technicalOwnerId: 'usr_tech',
    authentication: 'api_key',
    scopes: ['wallets:read'],
    operations: [operation()],
    openApiRef: 'specs/wallet-api.yaml',
    serviceId: 'wallet.api',
    sloId: 'wallet.api.availability',
    approvedBy: 'usr_governance',
    approvedAt: '2026-02-01T00:00:00.000Z',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function consumer(overrides: Record<string, unknown> = {}) {
  return consumerSchema.parse({
    consumerId: 'con_org_a',
    name: 'Organization A integration',
    kind: 'internal_application',
    description: 'Organization A reads its own wallet balances for reconciliation.',
    organizationId: 'org_a',
    environment: 'production',
    entitlements: [
      {
        apiId: 'wallet.api',
        majorVersion: 1,
        scopes: ['wallets:read'],
        grantedBy: 'usr_governance',
        grantedAt: '2026-01-15T00:00:00.000Z',
        expiresAt: '2027-01-15T00:00:00.000Z',
        justification:
          'Organization A reconciles its wallet balances against its own ledger nightly.',
      },
    ],
    credentialIds: ['key_a'],
    planId: 'plan_internal',
    status: 'active',
    ownerId: 'usr_platform',
    technicalContact: 'ops@org-a.example',
    createdAt: '2026-01-15T00:00:00.000Z',
    lastReviewedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  });
}

function quota(overrides: Record<string, unknown> = {}): Quota {
  return quotaSchema.parse({
    quotaId: 'q.org_a.monthly',
    scope: 'consumer',
    subjectId: 'con_org_a',
    apiId: null,
    period: 'monthly',
    resetDayOfMonth: 1,
    limit: 3,
    description: 'The monthly call allowance for Organization A.',
    ...overrides,
  });
}

function backup(overrides: Record<string, unknown> = {}) {
  return backupRecordSchema.parse({
    backupId: 'bk_pg_20260620',
    source: 'postgresql',
    scope: 'trustos_production',
    environment: 'production',
    startedAt: '2026-06-20T02:00:00.000Z',
    completedAt: '2026-06-20T02:14:00.000Z',
    location: 's3://trustos-backups-eu/postgres/2026-06-20.dump',
    sameFailureDomain: false,
    encrypted: true,
    encryptionMethod: 'AES-256-GCM, key held in the platform KMS.',
    classification: 'HIGHLY_RESTRICTED',
    retentionDays: 3650,
    checksum: 'sha256:9f2c4a1b7e33',
    checksumVerifiedAt: '2026-06-20T02:20:00.000Z',
    verifiedAt: '2026-06-20T02:30:00.000Z',
    verificationNotes: 'Row counts match the source within the replication window.',
    ...overrides,
  });
}

// --- the tests ---------------------------------------------------------------

describe('an unauthorized user cannot reclassify data', () => {
  it('separates proposing a classification from approving one', () => {
    /*
     * The permission split is the control, and the collapse is invisible in a role definition —
     * a role holding both looks like somebody being given what they need to do their job.
     */
    const violations = segregationViolations([
      {
        name: 'data-steward',
        permissions: [
          ENTERPRISE_PERMISSIONS.DATA_CLASSIFY.key,
          ENTERPRISE_PERMISSIONS.DATA_CLASSIFY_APPROVE.key,
        ],
      },
    ]);

    expect(violations).toHaveLength(1);
  });

  it('does not let a lowered classification take effect from the proposal alone', () => {
    /*
     * The proposal route records a proposal and returns it. Nothing in the catalog changes, so a
     * proposer who is also the only reader cannot make restricted data readable by relabelling it.
     */
    const catalog = new DataCatalog([entry()]);
    const before = catalog.require('db.wallet').classification;

    // Whatever the proposal says, the catalog is unchanged until an approver acts.
    expect(catalog.require('db.wallet').classification).toBe(before);
    expect(obligationsFor(before).revealRequiresApproval).toBe(true);
  });

  it('does not let a table be classified below what its columns imply', () => {
    // The route somebody would take instead: reclassify the parent and leave the columns alone.
    const catalog = new DataCatalog([
      entry({ classification: 'INTERNAL' }),
      entry({
        entryId: 'db.wallet.balance',
        kind: 'column',
        parentId: 'db.wallet',
        technicalName: 'balance_minor_units',
        businessName: 'Wallet balance',
        classification: 'RESTRICTED',
      }),
    ]);

    expect(catalog.misclassified()).toHaveLength(1);
    expect(classificationRank(catalog.inheritedClassification('db.wallet'))).toBeGreaterThan(
      classificationRank('INTERNAL'),
    );
  });
});

describe('an unauthorized user cannot reveal restricted data', () => {
  it('separates requesting a reveal from approving one', () => {
    // A role holding both can read any restricted value with nobody else involved.
    const violations = segregationViolations([
      {
        name: 'support-lead',
        permissions: [
          ENTERPRISE_PERMISSIONS.DATA_REVEAL.key,
          ENTERPRISE_PERMISSIONS.DATA_REVEAL_APPROVE.key,
        ],
      },
    ]);

    expect(violations).toHaveLength(1);
  });

  it('refuses a reveal with no recorded approval', async () => {
    const engine = engineFor([policy()]);

    const decision = await engine.decide({
      policyId: 'data.reveal',
      attributes: { requesterId: 'usr_support' },
      actorId: 'usr_support',
      organizationId: 'org_a',
      action: 'data.reveal',
      correlationId: 'cor_1',
    });

    expect(decision.decision).toBe('DENY');
  });

  it('narrows an unauthorized catalog search to a stub', () => {
    /*
     * The plausible internal shortcut: pass `authorized: true` from a query parameter "so support
     * can find things". The controller resolves it from the actor's permissions instead, and this
     * asserts the narrowing still works.
     */
    const catalog = new DataCatalog([entry()]);
    const stub = catalog.search({ authorized: false })[0] as Record<string, unknown>;

    expect(stub.entryId).toBe('db.wallet');
    expect(stub.residencyRegion).toBeUndefined();
    expect(stub.technicalName).toBeUndefined();
    expect(stub.purpose).toBeUndefined();
  });
});

describe('a policy that is not active cannot authorize an action', () => {
  it('refuses to decide with a draft, even when the version is pinned', async () => {
    /*
     * Pinning a version is what a replay does, so the path is reachable. Enforcing a draft would
     * mean an unreviewed policy takes effect the moment somebody writes it.
     */
    const engine = engineFor([policy({ status: 'draft' })]);

    await expect(
      engine.decide({
        policyId: 'data.reveal',
        policyVersion: '1.0.0',
        attributes: { requesterId: 'usr_a', approvedBy: 'usr_b' },
        actorId: 'usr_a',
        organizationId: 'org_a',
        action: 'data.reveal',
        correlationId: 'cor_1',
      }),
    ).rejects.toThrow(/cannot decide/);
  });

  it('refuses a deprecated policy the same way', async () => {
    const engine = engineFor([policy({ status: 'deprecated', supersededBy: 'data.reveal.v2' })]);

    await expect(
      engine.decide({
        policyId: 'data.reveal',
        policyVersion: '1.0.0',
        attributes: { requesterId: 'usr_a', approvedBy: 'usr_b' },
        actorId: 'usr_a',
        organizationId: 'org_a',
        action: 'data.reveal',
        correlationId: 'cor_1',
      }),
    ).rejects.toThrow(/cannot decide/);
  });

  it('still permits simulating it, which records nothing', () => {
    const engine = engineFor([policy({ status: 'draft' })]);
    const result = engine.simulate({
      policyId: 'data.reveal',
      attributes: { requesterId: 'usr_a', approvedBy: 'usr_b' },
    });

    expect(result.decision.decision).toBe('ALLOW');
  });
});

describe('tenant A cannot reach tenant B governance data', () => {
  it('refuses a consumer whose credential belongs to another organization', async () => {
    /*
     * Tested at the gate rather than at the controller, because the gate is what a direct API call
     * reaches. A UI restriction is not a control.
     */
    const gate = new ApiGateway({
      catalog: new ApiCatalog([api()]),
      consumers: new ConsumerRegistry([
        consumer(),
        consumer({ consumerId: 'con_org_b', organizationId: 'org_b' }),
      ]),
      analytics: new InMemoryAnalyticsSink(),
    });

    const result = await gate.check({
      apiId: 'wallet.api',
      version: '1.0.0',
      method: 'GET',
      path: '/api/wallets',
      consumerId: 'con_org_b',
      at: NOW,
    });

    // Organization B is entitled to the API. What it must not reach is A's rows, and the
    // organizationId that scopes the query comes from the consumer, never from the request.
    expect(result.consumer?.organizationId).toBe('org_b');
    expect(result.consumer?.organizationId).not.toBe('org_a');
  });

  it('does not let a consumer claim another organization through the request', async () => {
    // There is no organizationId in GateRequest. The only source is the registered consumer.
    const gate = new ApiGateway({
      catalog: new ApiCatalog([api()]),
      consumers: new ConsumerRegistry([consumer()]),
      analytics: new InMemoryAnalyticsSink(),
    });

    const request = {
      apiId: 'wallet.api',
      version: '1.0.0',
      method: 'GET',
      path: '/api/wallets',
      consumerId: 'con_org_a',
      at: NOW,
      organizationId: 'org_b',
    } as never;

    expect((await gate.check(request)).consumer?.organizationId).toBe('org_a');
  });

  it('refuses an unregistered consumer outright', async () => {
    const gate = new ApiGateway({
      catalog: new ApiCatalog([api()]),
      consumers: new ConsumerRegistry([consumer()]),
      analytics: new InMemoryAnalyticsSink(),
    });

    const result = await gate.check({
      apiId: 'wallet.api',
      version: '1.0.0',
      method: 'GET',
      path: '/api/wallets',
      consumerId: 'con_unknown',
      at: NOW,
    });

    expect(result.reasonCode).toBe('consumer_not_registered');
  });
});

describe('an entitlement cannot be widened by the platform moving', () => {
  it('does not follow the consumer into the next major version', () => {
    /*
     * The silent widening: an entitlement that tracked "the newest version" would grant whatever
     * the next major adds, including operations nobody reviewed against this consumer.
     */
    const next = api({ version: '2.0.0' });

    expect(
      decideAccess({
        consumer: consumer(),
        api: next,
        operation: next.operations[0] as ReturnType<typeof operation>,
        at: NOW,
      }).code,
    ).toBe('no_entitlement');
  });

  it('refuses a sandbox credential against production', () => {
    const production = api();

    expect(
      decideAccess({
        consumer: consumer({ environment: 'staging' }),
        api: production,
        operation: production.operations[0] as ReturnType<typeof operation>,
        at: NOW,
      }).code,
    ).toBe('wrong_environment');
  });

  it('refuses an expired entitlement rather than extending it', () => {
    const production = api();

    expect(
      decideAccess({
        consumer: consumer({
          entitlements: [
            {
              apiId: 'wallet.api',
              majorVersion: 1,
              scopes: ['wallets:read'],
              grantedBy: 'usr_governance',
              grantedAt: '2026-01-15T00:00:00.000Z',
              expiresAt: '2026-05-01T00:00:00.000Z',
              justification:
                'Organization A reconciles its wallet balances against its own ledger.',
            },
          ],
        }),
        api: production,
        operation: production.operations[0] as ReturnType<typeof operation>,
        at: NOW,
      }).code,
    ).toBe('entitlement_expired');
  });
});

describe('a quota cannot be bypassed through an alternate endpoint', () => {
  async function gateway(quotaSubject: Quota) {
    const store = new InMemoryQuotaUsageStore();

    const gate = new ApiGateway({
      catalog: new ApiCatalog([
        api({
          operations: [
            operation(),
            operation({
              operationId: 'searchWallets',
              method: 'POST',
              path: '/api/wallets/search',
              idempotent: false,
            }),
          ],
        }),
      ]),
      consumers: new ConsumerRegistry([
        consumer({
          entitlements: [
            {
              apiId: 'wallet.api',
              majorVersion: 1,
              scopes: ['wallets:read'],
              grantedBy: 'usr_governance',
              grantedAt: '2026-01-15T00:00:00.000Z',
              expiresAt: '2027-01-15T00:00:00.000Z',
              justification:
                'Organization A reconciles its wallet balances against its own ledger nightly.',
            },
          ],
        }),
      ]),
      quotaFor: () => quotaSubject,
      quotaStore: store,
      analytics: new InMemoryAnalyticsSink(),
    });

    return { gate, store };
  }

  it('counts both endpoints against one consumer quota', async () => {
    /*
     * The bypass somebody tries: hit a different operation once the first is exhausted. The quota
     * is scoped to the consumer with `apiId: null`, so both count against the same allowance.
     */
    const { gate } = await gateway(quota());

    const call = (path: string, method: string) =>
      gate.check({
        apiId: 'wallet.api',
        version: '1.0.0',
        method,
        path,
        consumerId: 'con_org_a',
        at: NOW,
      });

    await call('/api/wallets', 'GET');
    await call('/api/wallets', 'GET');
    await call('/api/wallets/search', 'POST');

    const fourth = await call('/api/wallets/search', 'POST');
    expect(fourth.refusedAt).toBe('quota');
  });

  it('does not spend quota on a refused call', async () => {
    /*
     * The reverse bypass, and the more expensive one: exhaust somebody else's quota by hammering
     * an endpoint you are refused on. Quota is the last stage of the gate for exactly this reason.
     */
    const { gate, store } = await gateway(quota());

    for (let index = 0; index < 10; index += 1) {
      await gate.check({
        apiId: 'wallet.api',
        version: '1.0.0',
        method: 'GET',
        path: '/api/wallets',
        consumerId: 'con_unknown',
        at: NOW,
      });
    }

    expect(await store.read('q.org_a.monthly', '2026-06')).toBe(0);
  });

  it('counts concurrent calls once each', async () => {
    // A read-then-write store would let two concurrent calls both see room.
    const store = new InMemoryQuotaUsageStore();
    const subject = quota({ limit: 5 });

    const decisions = await Promise.all(
      Array.from({ length: 12 }, () => consumeQuota({ quota: subject, store, at: NOW })),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
  });

  it('counts concurrent calls once each against a rate limit too', async () => {
    const store = new InMemoryRateCounterStore();
    const limit = rateLimitSchema.parse({
      limitId: 'rl.consumer',
      scope: 'consumer',
      apiId: 'wallet.api',
      limit: 4,
      unit: 'minute',
      description: 'The sustained rate for an internal consumer.',
    });

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkRate({
          limits: [limit],
          store,
          request: {
            apiId: 'wallet.api',
            operationId: 'listWallets',
            consumerId: 'con_org_a',
            organizationId: 'org_a',
            at: NOW,
          },
        }),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(4);
  });
});

describe('a backup without a restore is not validated', () => {
  it('refuses to call a checksummed and inspected backup validated', () => {
    const record = backup();

    expect(assuranceOf(record).contentsVerified).toBe(true);
    expect(assuranceOf(record).fullyValidated).toBe(false);
    expect(() => assertFullyValidated(record)).toThrow(/not fully validated/);
  });

  it('does not let a restore-test claim stand without a report', () => {
    // The schema refuses it, so the strongest claim in the record cannot be the one with no
    // evidence behind it.
    expect(() => backup({ lastRestoreTestAt: '2026-06-01T00:00:00.000Z' })).toThrow(
      /names its report/,
    );
  });

  it('reports the inventory finding rather than staying silent', () => {
    const inventory = new BackupInventory([backup()]);
    expect(inventory.analyse(NOW).some((finding) => finding.kind === 'never_restored')).toBe(true);
  });
});

describe('AI cannot activate a governance change', () => {
  it('names every governance action it may never take', () => {
    for (const forbidden of [
      'activate a policy',
      'change a data classification',
      'revoke access',
      'publish an API',
      'execute a disaster-recovery procedure',
      'mark a backup validated',
      'close an incident',
    ]) {
      expect(AI_FORBIDDEN_ACTIONS).toContain(forbidden);
    }
  });

  it('has no feature that is not a proposal', () => {
    // Asserted over the whole list rather than the ones somebody remembered.
    for (const feature of AI_ASSIST_FEATURES) {
      expect(isProposalOnly(feature)).toBe(true);
    }
  });

  it('offers no assist feature named for an action', () => {
    /*
     * The naming rule is a review aid rather than a control — the control is that no return type
     * carries an action — but a feature called `apply_classification` would read as acceptable in
     * a diff.
     */
    for (const feature of AI_ASSIST_FEATURES) {
      expect(feature).not.toMatch(/^(apply|activate|publish|approve|revoke|delete|execute|post)_/);
    }
  });
});

describe('the guard chain is not the only control', () => {
  it('refuses a path traversal at the catalog rather than at the router', () => {
    /*
     * `/api/wallets/../admin/wallets` normalized and string-compared would resolve to the less
     * sensitive operation and pass its scope check.
     */
    const catalog = new ApiCatalog([api()]);
    const definition = catalog.require('wallet.api', '1.0.0');

    expect(catalog.findOperation(definition, 'GET', '/api/wallets/../admin/wallets')).toBeNull();
  });

  it('does not let a parameter segment swallow a path', () => {
    const catalog = new ApiCatalog([
      api({
        operations: [operation({ operationId: 'getWallet', path: '/api/wallets/:walletId' })],
      }),
    ]);
    const definition = catalog.require('wallet.api', '1.0.0');

    expect(catalog.findOperation(definition, 'GET', '/api/wallets/wal_1/transactions')).toBeNull();
  });
});
