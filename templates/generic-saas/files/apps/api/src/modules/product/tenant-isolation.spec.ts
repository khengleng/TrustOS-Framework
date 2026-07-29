import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { ProductService } from './product.service';

/**
 * Tenant isolation for WorkspaceItem.
 *
 * Copy this file alongside every product entity you add. The framework
 * guarantees the guard and the query helpers; only a test proves that *your*
 * service actually used them.
 *
 * No database: isolation is a property of the query we build, so it is proven
 * against a fake delegate that applies filters exactly as Prisma would. That
 * keeps the test fast, deterministic, and runnable in CI with no services.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

function buildService(): { service: ProductService; sink: InMemoryAuditSink } {
  const delegate = new FakeModelDelegate([
    {
      id: 'item_acme',
      organizationId: ACME,
      name: 'Acme item',
      description: null,
      status: 'ACTIVE',
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'item_rival',
      organizationId: RIVAL,
      name: 'Rival item',
      description: null,
      status: 'ACTIVE',
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ]);

  // Stands in for PrismaService: the repository only ever reaches for the
  // model delegate by name.
  const prisma = { workspaceItem: delegate } as never;
  const sink = new InMemoryAuditSink();

  return { service: new ProductService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('WorkspaceItem tenant isolation', () => {
  let service: ProductService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization rows', async () => {
    expect((await asAcme(() => service.list())).map((row) => row.name)).toEqual(['Acme item']);
    expect((await asRival(() => service.list())).map((row) => row.name)).toEqual(['Rival item']);
  });

  it('stamps new rows with the calling organization', async () => {
    const created = await asAcme(() => service.create({ name: 'New' }, ACME));
    expect(created.organizationId).toBe(ACME);
  });

  it('refuses to read another organization row, reporting not_found', async () => {
    try {
      await asAcme(() => service.findById('item_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('refuses to update or delete another organization row', async () => {
    await expect(
      asAcme(() => service.update('item_rival', { name: 'hijacked' }, ACME)),
    ).rejects.toThrow();
    await expect(asAcme(() => service.remove('item_rival', ACME))).rejects.toThrow();

    // The rival's row is untouched.
    const rivalRows = await asRival(() => service.list());
    expect(rivalRows[0]?.name).toBe('Rival item');
    expect(rivalRows[0]?.deletedAt).toBeNull();
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(service.list()).rejects.toThrow(/Organization context is required/);
  });

  it('audits every mutation with the organization attached, and audits no reads', async () => {
    await asAcme(() => service.list());
    expect(sink.records).toHaveLength(0);

    const created = await asAcme(() => service.create({ name: 'Audited' }, ACME));
    await asAcme(() => service.update(created.id, { name: 'Renamed' }, ACME));
    await asAcme(() => service.remove(created.id, ACME));

    expect(sink.records.map((record) => record.action)).toEqual([
      'workspaceItem.created',
      'workspaceItem.updated',
      'workspaceItem.deleted',
    ]);
    expect(sink.records.every((record) => record.organizationId === ACME)).toBe(true);
  });

  it('records the previous value on update, so a change is answerable', async () => {
    await asAcme(() => service.update('item_acme', { name: 'Renamed' }, ACME));

    const record = sink.find('workspaceItem.updated');
    expect(record?.before).toEqual({ name: 'Acme item' });
    expect(record?.after).toEqual({ name: 'Renamed' });
  });
});
