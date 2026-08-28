import { describe, expect, it } from 'vitest';
import {
  ApiCatalog,
  apiClassification,
  apiDefinitionSchema,
  assertPublishable,
  compareSemver,
} from './index';

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
    version: '1.0.0',
    domain: 'merchant',
    environment: 'production',
    lifecycle: 'APPROVED',
    businessOwnerId: 'usr_business',
    technicalOwnerId: 'usr_tech',
    authentication: 'api_key',
    scopes: ['merchants:read'],
    operations: [operation()],
    openApiRef: 'specs/merchant-api-1.0.0.yaml',
    serviceId: 'merchant.api',
    sloId: 'merchant.api.availability',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('defining an API', () => {
  it('refuses an unauthenticated API over anything above public', () => {
    // An open endpoint over internal data, reachable by anyone who finds the path.
    expect(() => api({ authentication: 'none' })).toThrow(/open endpoint/);
  });

  it('permits an unauthenticated API over public data', () => {
    expect(
      api({
        authentication: 'none',
        operations: [operation({ classification: 'PUBLIC', scopes: [] })],
      }).authentication,
    ).toBe('none');
  });

  it('refuses the same method and path twice', () => {
    // The router picks one and nobody knows which.
    expect(() =>
      api({ operations: [operation(), operation({ operationId: 'listMerchantsV2' })] }),
    ).toThrow(/declared twice/);
  });

  it('refuses a GET declared as non-idempotent', () => {
    expect(() => api({ operations: [operation({ idempotent: false })] })).toThrow(
      /idempotent by definition/,
    );
  });

  it('refuses a deprecation with no retirement date', () => {
    // An announcement nobody has to act on.
    expect(() => api({ lifecycle: 'DEPRECATED' })).toThrow(/when calls stop working/);
  });

  it('refuses an API that supersedes itself', () => {
    expect(() =>
      api({
        lifecycle: 'DEPRECATED',
        retirementDate: '2026-12-01T00:00:00.000Z',
        supersededBy: 'merchant.api',
      }),
    ).toThrow(/does not supersede itself/);
  });
});

describe('classification', () => {
  it('is the highest across the operations, not what the API claims', () => {
    /*
     * The mechanism by which a restricted field reaches a public integration is an API classified
     * below what it returns. Deriving it removes the claim.
     */
    const mixed = api({
      operations: [
        operation({ classification: 'PUBLIC' }),
        operation({
          operationId: 'getLedger',
          path: '/api/merchants/:id/ledger',
          classification: 'HIGHLY_RESTRICTED',
        }),
      ],
    });

    expect(apiClassification(mixed)).toBe('HIGHLY_RESTRICTED');
  });

  it('is public only when everything it returns is', () => {
    expect(apiClassification(api({ operations: [operation({ classification: 'PUBLIC' })] }))).toBe(
      'PUBLIC',
    );
  });
});

describe('lifecycle', () => {
  it('refuses to move a published API back to draft', () => {
    // Once consumers exist, changing the contract is a new version rather than an edit.
    const catalog = new ApiCatalog([
      api({
        lifecycle: 'PUBLISHED',
        approvedBy: 'usr_governance',
        approvedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    expect(() =>
      catalog.transition({
        apiId: 'merchant.api',
        version: '1.0.0',
        to: 'DRAFT',
        actorId: 'usr_tech',
        reason: 'Reworking the contract.',
      }),
    ).toThrow(/does not move/);
  });

  it('refuses an owner approving their own production publication', () => {
    /*
     * The same self-approval the framework refuses everywhere else. An API going live is exactly
     * as consequential as the changes maker-checker protects.
     */
    const catalog = new ApiCatalog([api()]);

    expect(() =>
      catalog.transition({
        apiId: 'merchant.api',
        version: '1.0.0',
        to: 'PUBLISHED',
        actorId: 'usr_tech',
        reason: 'Ready to go.',
      }),
    ).toThrow(/does not approve their own/);
  });

  it('publishes when somebody else approves', () => {
    const catalog = new ApiCatalog([api()]);
    const published = catalog.transition({
      apiId: 'merchant.api',
      version: '1.0.0',
      to: 'PUBLISHED',
      actorId: 'usr_governance',
      reason: 'Reviewed against the API standard.',
    });

    expect(published.lifecycle).toBe('PUBLISHED');
    expect(published.approvedBy).toBe('usr_governance');
  });

  it('lets an owner publish outside production', () => {
    // The gate protects consumers, and a development API has none.
    const catalog = new ApiCatalog([api({ environment: 'development' })]);

    expect(
      catalog.transition({
        apiId: 'merchant.api',
        version: '1.0.0',
        to: 'PUBLISHED',
        actorId: 'usr_tech',
        reason: 'Development.',
      }).lifecycle,
    ).toBe('PUBLISHED');
  });

  it('does not let a retired API come back', () => {
    // Consumers were told it was gone. Reviving it is worse than a new version at the same path.
    const catalog = new ApiCatalog([
      api({
        lifecycle: 'RETIRED',
        approvedBy: 'usr_governance',
        approvedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    expect(() =>
      catalog.transition({
        apiId: 'merchant.api',
        version: '1.0.0',
        to: 'PUBLISHED',
        actorId: 'usr_governance',
        reason: 'A consumer complained.',
      }),
    ).toThrow(/does not move/);
  });
});

describe('resolving a request to an operation', () => {
  const catalog = new ApiCatalog([
    api({
      operations: [
        operation(),
        operation({ operationId: 'getMerchant', path: '/api/merchants/:merchantId' }),
        operation({
          operationId: 'adminList',
          path: '/api/admin/merchants',
          classification: 'RESTRICTED',
        }),
      ],
    }),
  ]);
  const definition = catalog.require('merchant.api', '1.0.0');

  it('matches a parameter against one concrete segment', () => {
    expect(catalog.findOperation(definition, 'GET', '/api/merchants/mer_1')?.operationId).toBe(
      'getMerchant',
    );
  });

  it('does not let a parameter swallow several segments', () => {
    expect(catalog.findOperation(definition, 'GET', '/api/merchants/mer_1/wallets')).toBeNull();
  });

  it('refuses a traversal', () => {
    /*
     * Normalizing both sides and comparing strings is how `/api/merchants/../admin/merchants`
     * resolves to the less sensitive operation and passes its scope check.
     */
    expect(
      catalog.findOperation(definition, 'GET', '/api/merchants/../admin/merchants'),
    ).toBeNull();
  });

  it('ignores the query string', () => {
    expect(
      catalog.findOperation(definition, 'GET', '/api/merchants?status=active')?.operationId,
    ).toBe('listMerchants');
  });

  it('matches the method too', () => {
    expect(catalog.findOperation(definition, 'DELETE', '/api/merchants/mer_1')).toBeNull();
  });
});

describe('versions', () => {
  const catalog = new ApiCatalog([
    api({ version: '1.0.0', lifecycle: 'DEPRECATED', retirementDate: '2026-12-01T00:00:00.000Z' }),
    api({
      version: '2.0.0',
      lifecycle: 'PUBLISHED',
      approvedBy: 'usr_governance',
      approvedAt: '2026-02-01T00:00:00.000Z',
    }),
    api({ version: '3.0.0', lifecycle: 'DRAFT' }),
  ]);

  it('resolves an unpinned caller to the newest published version', () => {
    // Not the newest — a draft is not something a caller should reach by omission.
    expect(catalog.current('merchant.api')?.version).toBe('2.0.0');
  });

  it('orders versions numerically rather than lexically', () => {
    expect(compareSemver('10.0.0', '9.0.0')).toBeGreaterThan(0);
  });

  it('refuses to register the same version twice', () => {
    expect(() => catalog.register(api({ version: '3.0.0', lifecycle: 'DRAFT' }))).toThrow(
      /already in the catalog/,
    );
  });
});

describe('findings', () => {
  it('names a deprecated API whose consumers have not moved', () => {
    /*
     * What makes a retirement date real. Deprecation is a promise to specific callers, and the
     * date means nothing unless you can see who is still there.
     */
    const catalog = new ApiCatalog([
      api({
        lifecycle: 'DEPRECATED',
        retirementDate: '2026-12-01T00:00:00.000Z',
        supersededBy: 'merchant.api.v2',
      }),
    ]);

    const finding = catalog.analyse({ consumersOf: () => ['con_partner_a', 'con_partner_b'] })[0];
    expect(finding?.kind).toBe('deprecated_with_active_consumers');
    expect(finding?.detail).toContain('con_partner_a');
  });

  it('names an API live in production with no recorded approval', () => {
    const catalog = new ApiCatalog([api({ lifecycle: 'PUBLISHED' })]);
    expect(catalog.analyse()[0]?.kind).toBe('published_without_approval');
  });

  it('is quiet about a deprecated API nobody calls', () => {
    const catalog = new ApiCatalog([
      api({
        lifecycle: 'DEPRECATED',
        retirementDate: '2026-12-01T00:00:00.000Z',
        approvedBy: 'usr_governance',
        approvedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    expect(catalog.analyse({ consumersOf: () => [] })).toHaveLength(0);
  });

  it('refuses to publish something with no document and no service', () => {
    expect(() => assertPublishable(api({ openApiRef: null, serviceId: null }))).toThrow(
      /not ready to publish/,
    );
  });
});
