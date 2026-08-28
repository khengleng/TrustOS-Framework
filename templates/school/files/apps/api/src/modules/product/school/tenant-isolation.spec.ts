import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { SchoolService } from './school.service';

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

function buildService(): { service: SchoolService; sink: InMemoryAuditSink } {
  const prisma = {
    academicTerm: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        name: 'acme',
        code: 'academic-term-acme',
        startsOn: new Date('2026-03-01T09:00:00.000Z'),
        endsOn: new Date('2026-03-01T09:00:00.000Z'),
        isCurrent: false,
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        name: 'rival',
        code: 'academic-term-rival',
        startsOn: new Date('2026-03-01T09:00:00.000Z'),
        endsOn: new Date('2026-03-01T09:00:00.000Z'),
        isCurrent: false,
        ...timestamps,
      },
    ]),
    classGroup: new FakeModelDelegate([]),
    attendance: new FakeModelDelegate([]),
    grade: new FakeModelDelegate([]),
    guardian: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new SchoolService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('school tenant isolation', () => {
  let service: SchoolService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s terms', async () => {
    expect((await asAcme(() => service.listAcademicTerms())).map((row) => row.id)).toEqual([
      'acme',
    ]);
    expect((await asRival(() => service.listAcademicTerms())).map((row) => row.id)).toEqual([
      'rival',
    ]);
  });

  it('reports another organization’s term as not_found', async () => {
    try {
      await asAcme(() => service.findAcademicTerm('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new term with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createAcademicTerm(
        {
          name: 'new',
          code: 'academic-term-new',
          startsOn: new Date('2026-03-01T09:00:00.000Z'),
          endsOn: new Date('2026-03-01T09:00:00.000Z'),
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
      service.createAcademicTerm(
        {
          name: 'audited',
          code: 'academic-term-audited',
          startsOn: new Date('2026-03-01T09:00:00.000Z'),
          endsOn: new Date('2026-03-01T09:00:00.000Z'),
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain('school.academic-term.created');
  });
});
