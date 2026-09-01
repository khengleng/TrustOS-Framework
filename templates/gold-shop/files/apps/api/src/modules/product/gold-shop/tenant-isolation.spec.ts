import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import type { ApiError } from '@trustsystem/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { GoldShopService } from './gold-shop.service';

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

function buildService(): { service: GoldShopService; sink: InMemoryAuditSink } {
  const prisma = {
    goldPrice: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        karat: 'K10',
        pricePerGram: '10.00',
        currency: 'acme',
        source: 'acme',
        quotedAt: new Date('2026-03-01T09:00:00.000Z'),
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        karat: 'K10',
        pricePerGram: '10.00',
        currency: 'rival',
        source: 'rival',
        quotedAt: new Date('2026-03-01T09:00:00.000Z'),
        ...timestamps,
      },
    ]),
    goldItem: new FakeModelDelegate([]),
    goldOrder: new FakeModelDelegate([]),
    goldInvoice: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new GoldShopService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('gold-shop tenant isolation', () => {
  let service: GoldShopService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s price quotes', async () => {
    expect((await asAcme(() => service.listGoldPrices())).map((row) => row.id)).toEqual(['acme']);
    expect((await asRival(() => service.listGoldPrices())).map((row) => row.id)).toEqual(['rival']);
  });

  it('reports another organization’s price quote as not_found', async () => {
    try {
      await asAcme(() => service.findGoldPrice('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new price quote with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createGoldPrice(
        {
          karat: 'K10',
          pricePerGram: '10.00',
          currency: 'new',
          source: 'new',
          quotedAt: new Date('2026-03-01T09:00:00.000Z'),
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
      service.createGoldPrice(
        {
          karat: 'K10',
          pricePerGram: '10.00',
          currency: 'audited',
          source: 'audited',
          quotedAt: new Date('2026-03-01T09:00:00.000Z'),
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain('goldshop.gold-price.created');
  });
});
