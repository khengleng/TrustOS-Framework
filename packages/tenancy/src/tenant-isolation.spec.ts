import { beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from '@trustsystem/shared-types';
import type { ApiError } from '@trustsystem/errors';
import {
  assertOrganizationAccess,
  assertTenantMatch,
  getTenantContext,
  requireOrganizationId,
  runInTenantContext,
  runWithoutTenantContext,
  scopedDelegate,
  tenantData,
  tenantWhere,
} from './index';
import { FakeModelDelegate, type FakeRow } from './testing/fake-delegate';

/**
 * Tenant isolation tests.
 *
 * These are the tests referenced in docs/security-standards.md: a change that
 * makes any of them fail is a cross-customer data exposure, not a regression
 * to be triaged later.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const seedRows = (): FakeRow[] => [
  { id: 'w_1', organizationId: ACME, name: 'Acme widget A' },
  { id: 'w_2', organizationId: ACME, name: 'Acme widget B' },
  { id: 'w_3', organizationId: RIVAL, name: 'Rival widget' },
];

const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({
  userId: 'user_1',
  email: 'ada@acme.test',
  organizationId: ACME,
  roles: ['administrator'],
  permissions: ['organization.read'],
  isSuperAdmin: false,
  tokenId: 'jti_1',
  ...overrides,
});

describe('tenant context', () => {
  it('exposes the organization inside the context and nothing outside it', () => {
    expect(getTenantContext()).toBeUndefined();

    runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, () => {
      expect(requireOrganizationId()).toBe(ACME);
      runWithoutTenantContext(() => {
        expect(getTenantContext()).toBeUndefined();
      });
      expect(requireOrganizationId()).toBe(ACME);
    });

    expect(getTenantContext()).toBeUndefined();
  });

  it('refuses to build a scoped query with no context rather than querying everything', () => {
    expect(() => tenantWhere({ isActive: true })).toThrowError(/Organization context is required/);
    expect(() => requireOrganizationId()).toThrowError(/Organization context is required/);
  });

  it('survives concurrent requests without leaking between them', async () => {
    const observe = async (organizationId: string, delayMs: number) =>
      runInTenantContext({ organizationId, actorId: 'user_1', isSuperAdmin: false }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return requireOrganizationId();
      });

    // Interleaved on purpose: the slow request must not observe the fast one.
    const [slow, fast] = await Promise.all([observe(ACME, 20), observe(RIVAL, 1)]);
    expect(slow).toBe(ACME);
    expect(fast).toBe(RIVAL);
  });
});

describe('tenantWhere / tenantData', () => {
  it('pins the query to the active organization', () => {
    runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, () => {
      expect(tenantWhere({ isActive: true })).toEqual({ isActive: true, organizationId: ACME });
      expect(tenantData({ name: 'x' })).toEqual({ name: 'x', organizationId: ACME });
    });
  });

  it('refuses a caller-supplied organization id that disagrees', () => {
    runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, () => {
      expect(() => tenantWhere({ organizationId: RIVAL })).toThrowError(
        /Cross-organization access is not permitted/,
      );
      expect(() => tenantData({ name: 'x', organizationId: RIVAL })).toThrowError(
        /Cross-organization access is not permitted/,
      );
      // Agreeing is fine.
      expect(tenantWhere({ organizationId: ACME })).toEqual({ organizationId: ACME });
    });
  });
});

describe('scopedDelegate', () => {
  let delegate: FakeModelDelegate;
  let widgets: FakeModelDelegate;

  beforeEach(() => {
    delegate = new FakeModelDelegate(seedRows());
    widgets = scopedDelegate(delegate, { model: 'widget' });
  });

  const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
    runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

  const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
    runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

  it('returns only the active organization rows from findMany', async () => {
    const rows = await asAcme(() => widgets.findMany());
    expect(rows.map((row) => row.id)).toEqual(['w_1', 'w_2']);

    const rivalRows = await asRival(() => widgets.findMany());
    expect(rivalRows.map((row) => row.id)).toEqual(['w_3']);
  });

  it('adds the organization filter even when the caller passes no arguments', async () => {
    await asAcme(() => widgets.findMany());
    expect(delegate.calls.at(-1)?.args).toEqual({ where: { organizationId: ACME } });
  });

  it('rewrites findUnique so a primary-key lookup cannot cross tenants', async () => {
    // The unscoped fake would happily return the rival's row for this id.
    await expect(delegate.findUnique({ where: { id: 'w_3' } })).resolves.not.toBeNull();

    const leaked = await asAcme(() => widgets.findUnique({ where: { id: 'w_3' } }));
    expect(leaked).toBeNull();
    expect(delegate.calls.at(-1)?.method).toBe('findFirst');
    expect(delegate.calls.at(-1)?.args).toEqual({ where: { id: 'w_3', organizationId: ACME } });
  });

  it('scopes count, update, delete and their bulk variants', async () => {
    expect(await asAcme(() => widgets.count())).toBe(2);

    await asAcme(() => widgets.updateMany({ where: {}, data: { name: 'renamed' } }));
    expect(delegate.snapshot().find((row) => row.id === 'w_3')?.name).toBe('Rival widget');

    await asAcme(() => widgets.deleteMany({ where: {} }));
    expect(delegate.snapshot().map((row) => row.id)).toEqual(['w_3']);
  });

  it('cannot update or delete another organization row by id', async () => {
    await expect(
      asAcme(() => widgets.update({ where: { id: 'w_3' }, data: { name: 'hijacked' } })),
    ).rejects.toThrow(/No record found/);

    await expect(asAcme(() => widgets.delete({ where: { id: 'w_3' } }))).rejects.toThrow(
      /No record found/,
    );

    expect(delegate.snapshot().find((row) => row.id === 'w_3')?.name).toBe('Rival widget');
  });

  it('stamps writes with the active organization and rejects a forged one', async () => {
    const created = await asAcme(() => widgets.create({ data: { name: 'new' } }));
    expect(created.organizationId).toBe(ACME);

    await expect(
      asAcme(() => widgets.create({ data: { name: 'planted', organizationId: RIVAL } })),
    ).rejects.toThrow(/Cross-organization access is not permitted/);

    await expect(
      asAcme(() =>
        widgets.createMany({
          data: [{ name: 'ok' }, { name: 'planted', organizationId: RIVAL }],
        }),
      ),
    ).rejects.toThrow(/Cross-organization access is not permitted/);
  });

  it('scopes upsert on both the lookup and the created row', async () => {
    const row = await asAcme(() =>
      widgets.upsert({ where: { id: 'w_3' }, create: { name: 'c' }, update: { name: 'u' } }),
    );
    // w_3 belongs to the rival, so this creates a new Acme row instead of
    // updating theirs.
    expect(row.organizationId).toBe(ACME);
    expect(delegate.snapshot().find((candidate) => candidate.id === 'w_3')?.name).toBe(
      'Rival widget',
    );
  });

  it('fails closed on an operation it does not know how to scope', async () => {
    await asAcme(async () => {
      await expect(
        (widgets as unknown as { executeRaw: () => Promise<unknown> }).executeRaw(),
      ).rejects.toThrow(/Unsupported operation on a tenant-scoped model/);
    });
  });

  it('reports a scope violation as a rejection, never a synchronous throw', async () => {
    // `create(...).catch(handler)` must see the failure.
    await asAcme(async () => {
      let caught: unknown = null;
      const returned = widgets.create({ data: { name: 'x', organizationId: RIVAL } });
      expect(returned).toBeInstanceOf(Promise);
      await returned.catch((error) => {
        caught = error;
      });
      expect(caught).toBeTruthy();
    });
  });

  it('refuses every operation when there is no tenant context at all', async () => {
    await expect(widgets.findMany()).rejects.toThrow(/Organization context is required/);
    await expect(widgets.create({ data: { name: 'x' } })).rejects.toThrow(
      /Organization context is required/,
    );
  });
});

describe('assertTenantMatch', () => {
  it('accepts a row from the active organization', () => {
    runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, () => {
      expect(assertTenantMatch({ id: 'w_1', organizationId: ACME }).id).toBe('w_1');
    });
  });

  it('reports another organization row as not_found, never as forbidden', () => {
    runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, () => {
      try {
        assertTenantMatch({ id: 'w_3', organizationId: RIVAL });
        expect.unreachable('should have thrown');
      } catch (error) {
        // 403 would confirm the id exists somewhere — an enumeration oracle.
        expect((error as ApiError).code).toBe('not_found');
      }
    });
  });

  it('treats a missing row and a foreign row identically', () => {
    runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, () => {
      const missing = captureError(() => assertTenantMatch(null));
      const foreign = captureError(() => assertTenantMatch({ id: 'x', organizationId: RIVAL }));
      expect(missing.code).toBe(foreign.code);
      expect(missing.message).toBe(foreign.message);
    });
  });
});

describe('assertOrganizationAccess', () => {
  it('allows an actor inside their own organization', () => {
    expect(() => assertOrganizationAccess(actor(), ACME)).not.toThrow();
  });

  it('blocks an actor reaching into another organization', () => {
    expect(() => assertOrganizationAccess(actor(), RIVAL)).toThrowError(/do not have permission/);
  });

  it('rejects an anonymous caller with 401', () => {
    expect(captureError(() => assertOrganizationAccess(null, ACME)).code).toBe('unauthorized');
  });

  it('permits a super admin, whose every use is audited', () => {
    expect(() =>
      assertOrganizationAccess(actor({ isSuperAdmin: true, organizationId: null }), RIVAL),
    ).not.toThrow();
  });
});

function captureError(fn: () => unknown): ApiError {
  try {
    fn();
    throw new Error('expected the call to throw');
  } catch (error) {
    return error as ApiError;
  }
}
