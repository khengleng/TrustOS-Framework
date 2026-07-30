import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { NgoService } from './ngo.service';

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

function buildService(): { service: NgoService; sink: InMemoryAuditSink } {
  const prisma = {
    programme: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        code: 'programme-acme',
        name: 'acme',
        summary: 'acme',
        status: 'PLANNED',
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        code: 'programme-rival',
        name: 'rival',
        summary: 'rival',
        status: 'PLANNED',
        ...timestamps,
      },
    ]),
    ngoProject: new FakeModelDelegate([]),
    donor: new FakeModelDelegate([]),
    donation: new FakeModelDelegate([]),
    beneficiary: new FakeModelDelegate([]),
    fieldReport: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new NgoService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('ngo tenant isolation', () => {
  let service: NgoService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s programmes', async () => {
    expect((await asAcme(() => service.listProgrammes())).map((row) => row.id)).toEqual(['acme']);
    expect((await asRival(() => service.listProgrammes())).map((row) => row.id)).toEqual(['rival']);
  });

  it('reports another organization’s programme as not_found', async () => {
    try {
      await asAcme(() => service.findProgramme('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new programme with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createProgramme(
        {
          code: 'programme-new',
          name: 'new',
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
      service.createProgramme(
        {
          code: 'programme-audited',
          name: 'audited',
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain('ngo.programme.created');
  });
});
