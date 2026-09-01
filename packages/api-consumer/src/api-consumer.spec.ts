import { describe, expect, it } from 'vitest';
import { ApiCatalog, apiDefinitionSchema } from '@trustsystem/api-catalog';
import {
  ConsumerRegistry,
  assertAccess,
  consumerSchema,
  decideAccess,
  reviewConsumer,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'listMerchants',
    method: 'GET',
    path: '/api/merchants',
    summary: 'Lists the merchants in the calling organization.',
    scopes: ['merchants:read'],
    classification: 'CONFIDENTIAL',
    idempotent: true,
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

function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    apiId: 'merchant.api',
    majorVersion: 1,
    operationIds: [],
    scopes: ['merchants:read'],
    grantedBy: 'usr_governance',
    grantedAt: '2026-01-15T00:00:00.000Z',
    expiresAt: '2027-01-15T00:00:00.000Z',
    justification:
      'The partner reconciles merchant records against their own onboarding system nightly.',
    ...overrides,
  };
}

function consumer(overrides: Record<string, unknown> = {}) {
  return consumerSchema.parse({
    consumerId: 'con_partner_a',
    name: 'Partner A',
    kind: 'partner',
    description: 'An onboarding partner that reconciles merchant records against its own system.',
    organizationId: 'org_platform',
    environment: 'production',
    entitlements: [entitlement()],
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

function call(overrides: { consumer?: unknown; api?: unknown } = {}) {
  const definition = (overrides.api as ReturnType<typeof api>) ?? api();
  return {
    consumer: (overrides.consumer as ReturnType<typeof consumer>) ?? consumer(),
    api: definition,
    operation: definition.operations[0] as ReturnType<typeof operation>,
    at: NOW,
  };
}

describe('defining a consumer', () => {
  it('refuses a developer consumer in production', () => {
    /*
     * A developer credential is the least controlled thing in any estate — it lives in a laptop, a
     * gist, a screenshot. It belongs on synthetic data, and the refusal is structural rather than
     * a note in the portal.
     */
    expect(() => consumer({ kind: 'developer' })).toThrow(/does not reach production/);
  });

  it('requires a suspension to say why', () => {
    expect(() => consumer({ status: 'suspended' })).toThrow(/says why/);
  });

  it('refuses two entitlements for the same API major', () => {
    // Whichever is evaluated first silently wins, and the other looks granted.
    expect(() =>
      consumer({ entitlements: [entitlement(), entitlement({ scopes: ['merchants:write'] })] }),
    ).toThrow(/silently wins/);
  });

  it('makes the owning organization explicit rather than optional', () => {
    // An omitted organization is the mistake that produces a cross-tenant read.
    expect(() => consumerSchema.parse({ ...consumer(), organizationId: undefined })).toThrow();
    expect(consumer({ organizationId: null }).organizationId).toBeNull();
  });
});

describe('deciding a call', () => {
  it('allows an entitled consumer', () => {
    expect(decideAccess(call()).allowed).toBe(true);
  });

  it('covers a minor version inside the entitled major', () => {
    // Minors are compatible by definition, so re-granting at each one is ceremony.
    expect(decideAccess(call({ api: api({ version: '1.9.3' }) })).allowed).toBe(true);
  });

  it('does not follow the entitlement into the next major', () => {
    /*
     * The rule this package exists for. An entitlement that tracked "the newest version" would
     * silently grant access to whatever the next major adds — including operations nobody reviewed
     * against this consumer.
     */
    const decision = decideAccess(call({ api: api({ version: '2.0.0' }) }));

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('no_entitlement');
  });

  it('refuses a suspended consumer', () => {
    const decision = decideAccess(
      call({
        consumer: consumer({
          status: 'suspended',
          suspensionReason: 'Repeated quota breaches under investigation.',
        }),
      }),
    );

    expect(decision.code).toBe('consumer_not_active');
  });

  it('refuses a sandbox credential against production', () => {
    expect(decideAccess(call({ consumer: consumer({ environment: 'staging' }) })).code).toBe(
      'wrong_environment',
    );
  });

  it('refuses an expired entitlement', () => {
    // Entitlements expire so that doing nothing ends access rather than extending it.
    const decision = decideAccess(
      call({
        consumer: consumer({
          entitlements: [entitlement({ expiresAt: '2026-05-01T00:00:00.000Z' })],
        }),
      }),
    );

    expect(decision.code).toBe('entitlement_expired');
  });

  it('refuses an operation outside a narrowed entitlement', () => {
    const decision = decideAccess(
      call({
        consumer: consumer({ entitlements: [entitlement({ operationIds: ['getMerchant'] })] }),
      }),
    );

    expect(decision.code).toBe('operation_not_entitled');
  });

  it('refuses a missing scope', () => {
    const decision = decideAccess(
      call({
        consumer: consumer({ entitlements: [entitlement({ scopes: ['reports:read'] })] }),
      }),
    );

    expect(decision.code).toBe('scope_not_granted');
  });

  it('accepts a write scope for a read operation', () => {
    // From @trustsystem/api-keys: a credential that may change something can necessarily observe it.
    expect(
      decideAccess(
        call({
          consumer: consumer({ entitlements: [entitlement({ scopes: ['merchants:write'] })] }),
        }),
      ).allowed,
    ).toBe(true);
  });

  it('refuses a retired version and names the successor', () => {
    const decision = decideAccess(
      call({
        api: api({
          lifecycle: 'RETIRED',
          retirementDate: '2026-05-01T00:00:00.000Z',
          supersededBy: 'merchant.api.v2',
        }),
      }),
    );

    expect(decision.reason).toContain('merchant.api.v2');
  });

  it('distinguishes its refusals rather than saying forbidden', () => {
    /*
     * A single "forbidden" is what makes integration support expensive: the integrator cannot tell
     * whether they need a scope, an entitlement, or a different version, so somebody reads logs.
     */
    const codes = new Set(
      [
        consumer({ status: 'revoked' }),
        consumer({ environment: 'staging' }),
        consumer({ entitlements: [entitlement({ scopes: ['reports:read'] })] }),
      ].map((subject) => decideAccess(call({ consumer: subject })).code),
    );

    expect(codes.size).toBe(3);
  });

  it('throws with the reason code attached', () => {
    try {
      assertAccess(call({ consumer: consumer({ entitlements: [] }) }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { context?: Record<string, unknown> }).context?.reason).toBe(
        'no_entitlement',
      );
    }
  });
});

describe('reviewing', () => {
  const catalog = new ApiCatalog([api()]);

  it('finds an entitlement above the ceiling for the consumer kind', () => {
    /*
     * One reasonable-looking grant. Nothing about the entitlement itself is wrong; what is wrong
     * is that the API returns RESTRICTED data and this consumer is a partner.
     */
    const restricted = new ApiCatalog([
      api({ operations: [operation({ classification: 'RESTRICTED' })] }),
    ]);

    const finding = reviewConsumer({ consumer: consumer(), catalog: restricted, at: NOW })[0];
    expect(finding?.kind).toBe('above_kind_ceiling');
    expect(finding?.severity).toBe('high');
  });

  it('permits the same API for an internal application', () => {
    const restricted = new ApiCatalog([
      api({ operations: [operation({ classification: 'RESTRICTED' })] }),
    ]);
    const internal = consumer({ consumerId: 'con_settlement', kind: 'internal_application' });

    expect(reviewConsumer({ consumer: internal, catalog: restricted, at: NOW })).toHaveLength(0);
  });

  it('finds an entitlement that never expires', () => {
    const findings = reviewConsumer({
      consumer: consumer({ entitlements: [entitlement({ expiresAt: null })] }),
      catalog,
      at: NOW,
    });

    expect(findings[0]?.kind).toBe('entitlement_never_expires');
  });

  it('finds a consumer nobody has looked at in a long time', () => {
    const findings = reviewConsumer({
      consumer: consumer({ lastReviewedAt: '2025-01-01T00:00:00.000Z' }),
      catalog,
      at: NOW,
    });

    expect(findings.some((finding) => finding.kind === 'never_reviewed')).toBe(true);
  });

  it('is quiet about a well-kept consumer', () => {
    expect(reviewConsumer({ consumer: consumer(), catalog, at: NOW })).toHaveLength(0);
  });
});

describe('the registry', () => {
  it('answers who is entitled to a version, for the catalog', () => {
    // What makes a deprecation date real: the list of callers who have not moved.
    const registry = new ConsumerRegistry([consumer(), consumer({ consumerId: 'con_partner_b' })]);
    expect(registry.consumersOf('merchant.api', '1.2.0')).toEqual([
      'con_partner_a',
      'con_partner_b',
    ]);
  });

  it('does not count a revoked consumer as a caller', () => {
    const registry = new ConsumerRegistry([consumer({ status: 'revoked' })]);
    expect(registry.consumersOf('merchant.api', '1.2.0')).toEqual([]);
  });

  it('finds a consumer from a verified credential', () => {
    // The only direction this package knows about credentials: id in, consumer out.
    expect(new ConsumerRegistry([consumer()]).byCredential('key_001')?.consumerId).toBe(
      'con_partner_a',
    );
  });

  it('refuses a scope the framework does not recognise', () => {
    expect(
      () =>
        new ConsumerRegistry([
          consumer({ entitlements: [entitlement({ scopes: ['MerchantsRead'] })] }),
        ]),
    ).toThrow();
  });

  it('refuses a wildcard scope', () => {
    // Reused from @trustsystem/api-keys rather than restated: a wildcard is not something to ask for.
    expect(
      () => new ConsumerRegistry([consumer({ entitlements: [entitlement({ scopes: ['*'] })] })]),
    ).toThrow();
  });
});

describe('a consumer with nothing granted yet', () => {
  it('registers', () => {
    /*
     * The normal state of a consumer created ahead of its first entitlement. Validating scopes
     * across the union rather than per entitlement refused this, because an empty scope list is
     * meaningless for a credential and ordinary for a consumer.
     */
    const registry = new ConsumerRegistry([consumer({ entitlements: [], status: 'pending' })]);
    expect(registry.require('con_partner_a').entitlements).toHaveLength(0);
  });

  it('is refused every call', () => {
    expect(decideAccess(call({ consumer: consumer({ entitlements: [] }) })).code).toBe(
      'no_entitlement',
    );
  });
});
