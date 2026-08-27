import { describe, expect, it } from 'vitest';
import { ApiCatalog, apiDefinitionSchema } from '@trustos/api-catalog';
import { consumerSchema } from '@trustos/api-consumer';
import {
  accessRequestSchema,
  assertSandboxOnly,
  credentialDisplay,
  decideRequest,
  developerRegistrationSchema,
  stalledRequests,
  visibilityFor,
  visibleCatalog,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'listMerchants',
    method: 'GET',
    path: '/api/merchants',
    summary: 'Lists the merchants in the calling organization.',
    scopes: ['merchants:read'],
    classification: 'PUBLIC',
    idempotent: true,
    ...overrides,
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return apiDefinitionSchema.parse({
    apiId: 'merchant.api',
    name: 'Merchant API',
    description: 'Registration, verification and profile management for merchants.',
    version: '1.0.0',
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

function registration(overrides: Record<string, unknown> = {}) {
  return developerRegistrationSchema.parse({
    registrationId: 'reg_001',
    email: 'dev@example.com',
    displayName: 'A Developer',
    claimedOrganization: 'Example Integrations',
    intendedUse: 'Building a reconciliation tool that reads merchant records nightly.',
    environment: 'development',
    status: 'active',
    registeredAt: '2026-05-01T00:00:00.000Z',
    verifiedAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return accessRequestSchema.parse({
    requestId: 'req_001',
    registrationId: 'reg_001',
    apiId: 'merchant.api',
    majorVersion: 1,
    requestedScopes: ['merchants:read'],
    environment: 'production',
    justification:
      'Our reconciliation tool needs to read merchant records nightly to match them against our onboarding system.',
    expectedCallsPerDay: 5_000,
    requestedAt: '2026-05-20T00:00:00.000Z',
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
        expiresAt: '2027-01-15T00:00:00.000Z',
        justification:
          'The partner reconciles merchant records against their own onboarding system nightly.',
      },
    ],
    credentialIds: ['key_001'],
    status: 'active',
    ownerId: 'usr_partnerships',
    technicalContact: 'integrations@partner-a.example',
    createdAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  });
}

describe('the sandbox boundary', () => {
  it('refuses a portal credential for production', () => {
    /*
     * The rule the package exists for. A self-service flow that can produce production access will,
     * and the credential it produces lives in a laptop, a gist and a screenshot.
     */
    expect(() =>
      assertSandboxOnly({ registration: registration(), environment: 'production' }),
    ).toThrow(/sandbox credentials only/);
  });

  it('permits one for development', () => {
    expect(() =>
      assertSandboxOnly({ registration: registration(), environment: 'development' }),
    ).not.toThrow();
  });

  it('does not let a registration claim any other environment', () => {
    // The field is a literal so a future production registration is a visible schema change.
    expect(() => registration({ environment: 'production' })).toThrow();
  });
});

describe('what the portal shows', () => {
  const anonymous = { consumer: null };

  it('shows a public API to anyone', () => {
    const visibility = visibilityFor({ api: api(), viewer: anonymous });
    expect(visibility.listed).toBe(true);
    expect(visibility.documented).toBe(true);
  });

  it('lists an internal API but does not document it', () => {
    /*
     * Listing and documenting leak differently: listing says the API exists, documenting names its
     * fields, error codes and business rules.
     */
    const visibility = visibilityFor({
      api: api({ operations: [operation({ classification: 'INTERNAL' })] }),
      viewer: anonymous,
    });

    expect(visibility.listed).toBe(true);
    expect(visibility.documented).toBe(false);
    expect(visibility.requestable).toBe(true);
  });

  it('does not admit that a restricted API exists', () => {
    /*
     * A greyed-out entry saying "contact us for access to the Ledger API" is most of the
     * reconnaissance an attacker wanted from the portal, served by the documentation site.
     */
    const visibility = visibilityFor({
      api: api({ operations: [operation({ classification: 'RESTRICTED' })] }),
      viewer: anonymous,
    });

    expect(visibility.listed).toBe(false);
    expect(visibility.requestable).toBe(false);
  });

  it('documents a restricted API to a consumer already entitled to it', () => {
    const visibility = visibilityFor({
      api: api({ operations: [operation({ classification: 'RESTRICTED' })] }),
      viewer: { consumer: consumer() },
    });

    expect(visibility.documented).toBe(true);
  });

  it('hides an unpublished API from everyone outside', () => {
    // An unpublished API in a public catalog is a roadmap.
    const draft = api({ lifecycle: 'DRAFT', approvedBy: null, approvedAt: null });

    expect(visibilityFor({ api: draft, viewer: anonymous }).listed).toBe(false);
    expect(visibilityFor({ api: draft, viewer: { consumer: null, isInternal: true } }).listed).toBe(
      true,
    );
  });

  it('filters the catalog for one viewer', () => {
    const catalog = new ApiCatalog([
      api(),
      api({
        apiId: 'ledger.api',
        operations: [operation({ classification: 'HIGHLY_RESTRICTED' })],
      }),
    ]);

    expect(visibleCatalog({ catalog, viewer: anonymous }).map((entry) => entry.apiId)).toEqual([
      'merchant.api',
    ]);
  });
});

describe('credentials', () => {
  it('shows a prefix and says the key is gone', () => {
    /*
     * The portal is exactly where somebody adds a "show key" button. @trustos/api-keys makes that
     * impossible by hashing; this makes the correct answer one call away.
     */
    const display = credentialDisplay({
      keyPrefix: 'tos_test_ab',
      name: 'Sandbox key',
      createdAt: '2026-05-02T00:00:00.000Z',
      expiresAt: null,
      lastUsedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(display.display).toBe('tos_test_ab…');
    expect(display.note).toContain('not stored');
    expect(JSON.stringify(display)).not.toContain('hash');
  });
});

describe('deciding a request', () => {
  it('approves with a named decider and the consumer it created', () => {
    const decided = decideRequest({
      request: request(),
      decision: 'approved',
      decidedBy: 'usr_partnerships',
      reason: 'Contract signed; the volume matches the partner plan.',
      consumerId: 'con_partner_a',
      api: api(),
      at: NOW,
    });

    expect(decided.status).toBe('approved');
    expect(decided.consumerId).toBe('con_partner_a');
  });

  it('requires an approval to name what it created', () => {
    // Otherwise the grant exists in a decision record and nowhere the platform enforces.
    expect(() =>
      decideRequest({
        request: request(),
        decision: 'approved',
        decidedBy: 'usr_partnerships',
        reason: 'Contract signed.',
        api: api(),
        at: NOW,
      }),
    ).toThrow(/names the consumer/);
  });

  it('requires a rejection to say why', () => {
    expect(() => request({ status: 'rejected', decidedBy: 'usr_partnerships' })).toThrow(
      /says why/,
    );
  });

  it('requires an explicit acknowledgement above the developer ceiling', () => {
    /*
     * Not ceremony. An approver working through a queue of requests is the mechanism by which
     * somebody ends up entitled to restricted data, and the acknowledgement is what interrupts it.
     */
    const restricted = api({ operations: [operation({ classification: 'RESTRICTED' })] });

    expect(() =>
      decideRequest({
        request: request(),
        decision: 'approved',
        decidedBy: 'usr_partnerships',
        reason: 'Contract signed.',
        consumerId: 'con_partner_a',
        api: restricted,
        at: NOW,
      }),
    ).toThrow(/acknowledging that explicitly/);

    expect(
      decideRequest({
        request: request(),
        decision: 'approved',
        decidedBy: 'usr_partnerships',
        reason: 'Contract signed; the restricted fields are covered by the data-sharing schedule.',
        consumerId: 'con_partner_a',
        api: restricted,
        acknowledgedClassification: 'RESTRICTED',
        at: NOW,
      }).status,
    ).toBe('approved');
  });

  it('refuses production access to an API that is not published there', () => {
    expect(() =>
      decideRequest({
        request: request(),
        decision: 'approved',
        decidedBy: 'usr_partnerships',
        reason: 'Contract signed.',
        consumerId: 'con_partner_a',
        api: api({ environment: 'staging' }),
        at: NOW,
      }),
    ).toThrow(/does not exist there/);
  });

  it('refuses to decide a request twice', () => {
    const decided = decideRequest({
      request: request(),
      decision: 'rejected',
      decidedBy: 'usr_partnerships',
      reason: 'The intended use is covered by the existing partner integration.',
      at: NOW,
    });

    expect(() =>
      decideRequest({
        request: decided,
        decision: 'approved',
        decidedBy: 'usr_other',
        reason: 'Reconsidered.',
        at: NOW,
      }),
    ).toThrow(/already rejected/);
  });
});

describe('the queue', () => {
  it('surfaces requests nobody answered', () => {
    // A queue nobody drains is how developers conclude the platform is not serious.
    const answered = request({
      requestId: 'req_002',
      status: 'approved',
      decidedBy: 'usr_partnerships',
      decidedAt: '2026-05-21T00:00:00.000Z',
      decisionReason: 'Approved against the partner plan.',
      consumerId: 'con_partner_b',
    });

    const stalled = stalledRequests([request(), answered], { asOf: NOW });

    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.daysWaiting).toBe(12);
  });

  it('is quiet inside the service level', () => {
    expect(
      stalledRequests([request({ requestedAt: '2026-05-30T00:00:00.000Z' })], { asOf: NOW }),
    ).toHaveLength(0);
  });
});
