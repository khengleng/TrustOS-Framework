import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import type { ApiError } from '@trustsystem/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { MarketplaceService } from './marketplace.service';

/**
 * Tenant isolation.
 *
 * The quietest failure a generated application can have: a query that returns another
 * organization’s rows. It breaks nothing, fails no build, and is discovered by a customer.
 *
 * The fake delegate and the tenant context come from `@trustsystem/tenancy` rather than being
 * rebuilt here. A hand-rolled fake that ignored the scope it was passed would make this suite
 * pass against a broken repository, which is worse than having no suite.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

function buildService(): { service: MarketplaceService; sink: InMemoryAuditSink } {
  const prisma = {
    seller: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        merchantId: 'merchant_acme',
        displayName: 'acme',
        code: 'seller-acme',
        status: 'ONBOARDING',
        commissionRate: 'acme',
        payoutCurrency: 'acme',
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        merchantId: 'merchant_rival',
        displayName: 'rival',
        code: 'seller-rival',
        status: 'ONBOARDING',
        commissionRate: 'rival',
        payoutCurrency: 'rival',
        ...timestamps,
      },
    ]),
    listing: new FakeModelDelegate([]),
    sellerPayout: new FakeModelDelegate([]),
    dispute: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new MarketplaceService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('marketplace tenant isolation', () => {
  let service: MarketplaceService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s sellers', async () => {
    expect((await asAcme(() => service.listSellers())).map((row) => row.id)).toEqual(['acme']);
    expect((await asRival(() => service.listSellers())).map((row) => row.id)).toEqual(['rival']);
  });

  it('reports another organization’s seller as not_found', async () => {
    try {
      await asAcme(() => service.findSeller('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new seller with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createSeller(
        {
          merchantId: 'merchant_new',
          displayName: 'new',
          code: 'seller-new',
          commissionRate: 'new',
          payoutCurrency: 'new',
        } as never,
        ACME,
      ),
    );

    expect(created.organizationId).toBe(ACME);
  });

  it('records an audit entry for the write', async () => {
    /*
     * A change with no audit row is a change nobody can answer questions about six
     * months later, and the answer is always needed at the worst moment.
     */
    await asAcme(() =>
      service.createSeller(
        {
          merchantId: 'merchant_audited',
          displayName: 'audited',
          code: 'seller-audited',
          commissionRate: 'audited',
          payoutCurrency: 'audited',
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain('marketplace.seller.created');
  });
});
