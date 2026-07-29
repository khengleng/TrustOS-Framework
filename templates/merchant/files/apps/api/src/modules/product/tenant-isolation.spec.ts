import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { ProductService } from './product.service';

/**
 * Tenant isolation for the merchant domain.
 *
 * Copy this file alongside every entity you add. The framework guarantees the
 * guard and the query helpers; only a test proves that *your* service used
 * them.
 *
 * No database: isolation is a property of the query we build, so it is proven
 * against a fake delegate that applies filters exactly as Prisma would.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

function buildService(): { service: ProductService; sink: InMemoryAuditSink } {
  const prisma = {
    merchant: new FakeModelDelegate([
      {
        id: 'm_acme',
        organizationId: ACME,
        name: 'Acme Retail',
        code: 'ACME',
        legalName: null,
        status: 'ACTIVE',
        contactEmail: null,
        contactPhone: null,
        ...timestamps,
      },
      {
        id: 'm_rival',
        organizationId: RIVAL,
        name: 'Rival Retail',
        code: 'RIVAL',
        legalName: null,
        status: 'ACTIVE',
        contactEmail: null,
        contactPhone: null,
        ...timestamps,
      },
    ]),
    store: new FakeModelDelegate([
      {
        id: 's_acme',
        organizationId: ACME,
        merchantId: 'm_acme',
        name: 'Acme Store',
        code: 'AS1',
        status: 'ACTIVE',
        timezone: 'Asia/Phnom_Penh',
        ...timestamps,
      },
      {
        id: 's_rival',
        organizationId: RIVAL,
        merchantId: 'm_rival',
        name: 'Rival Store',
        code: 'RS1',
        status: 'ACTIVE',
        timezone: 'Asia/Phnom_Penh',
        ...timestamps,
      },
    ]),
    branch: new FakeModelDelegate([]),
    merchantMember: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new ProductService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('merchant tenant isolation', () => {
  let service: ProductService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization merchants and stores', async () => {
    expect((await asAcme(() => service.listMerchants())).map((row) => row.code)).toEqual(['ACME']);
    expect((await asRival(() => service.listMerchants())).map((row) => row.code)).toEqual([
      'RIVAL',
    ]);
    expect((await asAcme(() => service.listStores())).map((row) => row.code)).toEqual(['AS1']);
  });

  it('stamps new rows with the calling organization', async () => {
    const merchant = await asAcme(() => service.createMerchant({ name: 'New', code: 'NEW' }, ACME));
    expect(merchant.organizationId).toBe(ACME);
  });

  it('reports another organization merchant as not_found', async () => {
    try {
      await asAcme(() => service.findMerchant('m_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('refuses to attach a store to another organization merchant', async () => {
    // The row would be stamped with the caller's organization, so no isolation
    // test would fail — but the parent reference would be wrong. The service
    // verifies the parent through the scoped repository first.
    await expect(
      asAcme(() =>
        service.createStore({ merchantId: 'm_rival', name: 'Sneaky', code: 'SNK' }, ACME),
      ),
    ).rejects.toThrow();

    expect(await asAcme(() => service.listStores())).toHaveLength(1);
  });

  it('refuses to attach a branch to another organization store', async () => {
    await expect(
      asAcme(() =>
        service.createBranch({ storeId: 's_rival', name: 'Sneaky', code: 'SNKB' }, ACME),
      ),
    ).rejects.toThrow();
  });

  it('refuses to change the status of another organization merchant', async () => {
    await expect(
      asAcme(() => service.updateMerchantStatus('m_rival', 'SUSPENDED', ACME)),
    ).rejects.toThrow();

    const rival = await asRival(() => service.findMerchant('m_rival', RIVAL));
    expect(rival.status).toBe('ACTIVE');
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(service.listMerchants()).rejects.toThrow(/Organization context is required/);
  });

  it('audits every mutation with the organization attached, and audits no reads', async () => {
    await asAcme(() => service.listMerchants());
    expect(sink.records).toHaveLength(0);

    const merchant = await asAcme(() =>
      service.createMerchant({ name: 'Audited', code: 'AUD' }, ACME),
    );
    await asAcme(() => service.updateMerchantStatus(merchant.id, 'SUSPENDED', ACME));

    expect(sink.records.map((record) => record.action)).toEqual([
      'merchant.created',
      'merchant.status_changed',
    ]);
    expect(sink.records.every((record) => record.organizationId === ACME)).toBe(true);
  });

  it('records the previous status on change, so the decision is answerable', async () => {
    await asAcme(() => service.updateMerchantStatus('m_acme', 'SUSPENDED', ACME));

    const record = sink.find('merchant.status_changed');
    expect(record?.before).toEqual({ status: 'ACTIVE' });
    expect(record?.after).toEqual({ status: 'SUSPENDED' });
  });
});
