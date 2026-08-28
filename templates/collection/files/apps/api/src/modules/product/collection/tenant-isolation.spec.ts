import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { CollectionService } from './collection.service';

/**
 * Tenant isolation.
 *
 * The quietest failure a generated application can have: a query that returns another
 * organization’s rows. It breaks nothing, fails no build, and is discovered by a customer.
 *
 * The fake delegate and the tenant context come from `@trustos/tenancy` rather than being
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

function buildService(): { service: CollectionService; sink: InMemoryAuditSink } {
  const prisma = {
    collector: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        userId: 'acme',
        displayName: 'acme',
        team: 'acme',
        isActive: false,
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        userId: 'rival',
        displayName: 'rival',
        team: 'rival',
        isActive: false,
        ...timestamps,
      },
    ]),
    collectionCase: new FakeModelDelegate([]),
    caseAssignment: new FakeModelDelegate([]),
    paymentPromise: new FakeModelDelegate([]),
    fieldVisit: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new CollectionService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('collection tenant isolation', () => {
  let service: CollectionService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s collectors', async () => {
    expect((await asAcme(() => service.listCollectors())).map((row) => row.id)).toEqual(['acme']);
    expect((await asRival(() => service.listCollectors())).map((row) => row.id)).toEqual(['rival']);
  });

  it('reports another organization’s collector as not_found', async () => {
    try {
      await asAcme(() => service.findCollector('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new collector with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createCollector(
        {
          userId: 'new',
          displayName: 'new',
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
      service.createCollector(
        {
          userId: 'audited',
          displayName: 'audited',
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain('collection.collector.created');
  });
});
