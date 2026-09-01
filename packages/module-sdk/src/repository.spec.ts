import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustsystem/errors';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { ModuleRepository } from './repository';

/**
 * Tenant isolation for module persistence.
 *
 * `ModuleRepository` is the only way module code reaches the database, so these
 * assertions cover every module at once: if the repository cannot cross an
 * organization boundary, no module built on it can either.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

interface Row {
  id: string;
  organizationId: string;
  label: string;
  deletedAt: Date | null;
  createdAt: Date;
}

function build(): { repository: ModuleRepository<Row>; delegate: FakeModelDelegate } {
  const delegate = new FakeModelDelegate([
    {
      id: 'row_acme',
      organizationId: ACME,
      label: 'Acme row',
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'row_rival',
      organizationId: RIVAL,
      label: 'Rival row',
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  ]);

  const prisma = { demoThing: delegate } as unknown as object;
  return { repository: new ModuleRepository<Row>(prisma, 'demoThing', 'demo'), delegate };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

describe('ModuleRepository', () => {
  let repository: ModuleRepository<Row>;
  let delegate: FakeModelDelegate;

  beforeEach(() => {
    ({ repository, delegate } = build());
  });

  it('lists only the calling organization rows', async () => {
    const rows = await asAcme(() => repository.list());
    expect(rows.map((row) => row.label)).toEqual(['Acme row']);
  });

  it('reports another organization row as not_found', async () => {
    try {
      await asAcme(() => repository.findById('row_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      // not_found, never forbidden: a 403 would confirm the id exists in
      // another organization and turn the endpoint into an enumeration oracle.
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('stamps the organization on create rather than trusting the caller', async () => {
    const created = await asAcme(() => repository.create({ label: 'New' }));
    expect(created.organizationId).toBe(ACME);
  });

  it('refuses a create that names a different organization', async () => {
    await expect(
      asAcme(() => repository.create({ label: 'Sneaky', organizationId: RIVAL })),
    ).rejects.toThrow(/Cross-organization/);
  });

  it('cannot update or soft-delete another organization row', async () => {
    await expect(asAcme(() => repository.update('row_rival', { label: 'x' }))).rejects.toThrow();
    await expect(asAcme(() => repository.softDelete('row_rival', new Date()))).rejects.toThrow();

    expect(delegate.snapshot().find((row) => row.id === 'row_rival')?.label).toBe('Rival row');
  });

  it('excludes soft-deleted rows unless asked', async () => {
    await asAcme(() => repository.softDelete('row_acme', new Date('2026-02-01T00:00:00.000Z')));

    expect(await asAcme(() => repository.list())).toHaveLength(0);
    expect(await asAcme(() => repository.list({ includeDeleted: true }))).toHaveLength(1);
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(repository.list()).rejects.toThrow(/Organization context is required/);
  });

  it('explains itself when the module has no database', async () => {
    const detached = new ModuleRepository<Row>(null, 'demoThing', 'demo');
    expect(detached.available).toBe(false);
    await expect(asAcme(() => detached.list())).rejects.toThrow(/needs a database/);
  });

  it('names the missing model rather than failing obscurely', async () => {
    const empty = new ModuleRepository<Row>({}, 'demoThing', 'demo');
    // The likely cause is a module installed without running its migration, so
    // the message says so instead of surfacing "cannot read property of
    // undefined" from inside the proxy.
    await expect(asAcme(() => empty.list())).rejects.toThrow(/Run the module's migration/);
  });
});
