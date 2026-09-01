import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import type { ApiError } from '@trustsystem/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { InsuranceService } from './insurance.service';

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

function buildService(): { service: InsuranceService; sink: InMemoryAuditSink } {
  const prisma = {
    policyHolder: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        holderNumber: 'acme',
        fullName: 'acme',
        email: 'acme@example.test',
        phone: '012345678',
        dateOfBirth: new Date('2026-03-01T09:00:00.000Z'),
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        holderNumber: 'rival',
        fullName: 'rival',
        email: 'rival@example.test',
        phone: '012345678',
        dateOfBirth: new Date('2026-03-01T09:00:00.000Z'),
        ...timestamps,
      },
    ]),
    insuranceProduct: new FakeModelDelegate([]),
    policy: new FakeModelDelegate([]),
    premium: new FakeModelDelegate([]),
    claim: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new InsuranceService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('insurance tenant isolation', () => {
  let service: InsuranceService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s policyholders', async () => {
    expect((await asAcme(() => service.listPolicyHolders())).map((row) => row.id)).toEqual([
      'acme',
    ]);
    expect((await asRival(() => service.listPolicyHolders())).map((row) => row.id)).toEqual([
      'rival',
    ]);
  });

  it('reports another organization’s policyholder as not_found', async () => {
    try {
      await asAcme(() => service.findPolicyHolder('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new policyholder with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createPolicyHolder(
        {
          holderNumber: 'new',
          fullName: 'new',
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
      service.createPolicyHolder(
        {
          holderNumber: 'audited',
          fullName: 'audited',
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain(
      'insurance.policy-holder.created',
    );
  });
});
