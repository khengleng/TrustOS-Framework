import { beforeEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import type { ApiError } from '@trustos/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { HelpdeskService } from './helpdesk.service';

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

function buildService(): { service: HelpdeskService; sink: InMemoryAuditSink } {
  const prisma = {
    ticketQueue: new FakeModelDelegate([
      {
        id: 'acme',
        organizationId: ACME,
        name: 'acme',
        code: 'ticket-queue-acme',
        description: 'acme',
        isActive: false,
        ...timestamps,
      },
      {
        id: 'rival',
        organizationId: RIVAL,
        name: 'rival',
        code: 'ticket-queue-rival',
        description: 'rival',
        isActive: false,
        ...timestamps,
      },
    ]),
    supportAgent: new FakeModelDelegate([]),
    slaPolicy: new FakeModelDelegate([]),
    ticket: new FakeModelDelegate([]),
    ticketComment: new FakeModelDelegate([]),
  } as never;

  const sink = new InMemoryAuditSink();
  return { service: new HelpdeskService(prisma, new AuditService({ sink })), sink };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

describe('helpdesk tenant isolation', () => {
  let service: HelpdeskService;
  let sink: InMemoryAuditSink;

  beforeEach(() => {
    ({ service, sink } = buildService());
  });

  it('lists only the calling organization’s queues', async () => {
    expect((await asAcme(() => service.listTicketQueues())).map((row) => row.id)).toEqual(['acme']);
    expect((await asRival(() => service.listTicketQueues())).map((row) => row.id)).toEqual([
      'rival',
    ]);
  });

  it('reports another organization’s queue as not_found', async () => {
    try {
      await asAcme(() => service.findTicketQueue('rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found rather than forbidden: a 403 would confirm the id exists.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps a new queue with the calling organization', async () => {
    const created = await asAcme(() =>
      service.createTicketQueue(
        {
          name: 'new',
          code: 'ticket-queue-new',
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
      service.createTicketQueue(
        {
          name: 'audited',
          code: 'ticket-queue-audited',
        } as never,
        ACME,
      ),
    );

    expect(sink.records.map((record) => record.action)).toContain('helpdesk.ticket-queue.created');
  });
});
