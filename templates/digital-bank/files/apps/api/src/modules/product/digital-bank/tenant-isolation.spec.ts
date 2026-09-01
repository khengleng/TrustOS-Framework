import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import type { ApiError } from '@trustsystem/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { DigitalBankService } from './digital-bank.service';

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

function buildService(): { service: DigitalBankService; sink: InMemoryAuditSink } {
  const prisma = {
    bankCustomer: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        customerNumber: 'acme',
        fullName: 'acme',
        email: 'acme@example.test',
        phone: '012345678',
        segment: 'RETAIL',
        status: 'PENDING',
        onboardedAt: new Date('2026-03-01T09:00:00.000Z'),
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        customerNumber: 'rival',
        fullName: 'rival',
        email: 'rival@example.test',
        phone: '012345678',
        segment: 'RETAIL',
        status: 'PENDING',
        onboardedAt: new Date('2026-03-01T09:00:00.000Z'),
        ...timestamps,
      },
    ]),
    bankAccount: new FakeModelDelegate([]),
    accountStatement: new FakeModelDelegate([]),
    customerNotificationPreference: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new DigitalBankService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('digital-bank tenant isolation', () => {
  let service: DigitalBankService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s customers', async () => {
    expect((await asAcme(() => service.listBankCustomers())).map((row) => row.id)).toEqual([
      'acme',
    ]);
    expect((await asRival(() => service.listBankCustomers())).map((row) => row.id)).toEqual([
      'rival',
    ]);
  });

  it('reports another organization’s customer as not_found', async () => {
    try {
      await asAcme(() => service.findBankCustomer('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new customer with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createBankCustomer(
        {
          customerNumber: 'new',
          fullName: 'new',
          onboardedAt: new Date('2026-03-01T09:00:00.000Z'),
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
      service.createBankCustomer(
        {
          customerNumber: 'audited',
          fullName: 'audited',
          onboardedAt: new Date('2026-03-01T09:00:00.000Z'),
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain(
      'digitalbank.bank-customer.created',
    );
  });
});
