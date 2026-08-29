import { describe, expect, it } from 'vitest';
import { PrismaAccessResolver, type AccessResolverStore } from './prisma-access-resolver';

/**
 * A stand-in for the one query this resolver makes.
 *
 * It records the `where` it was handed, because *what the resolver asks the database* is
 * half of what these tests are about: a resolver that returned the right answer while
 * quietly ignoring `deletedAt` would pass a naive test and hand access to a deleted
 * account.
 */
function store(row: unknown): AccessResolverStore & { lastWhere: Record<string, unknown> | null } {
  const spy = {
    lastWhere: null as Record<string, unknown> | null,
    user: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        spy.lastWhere = args.where;
        return row as never;
      },
    },
  };
  return spy;
}

const role = (name: string, permissions: string[]) => ({
  role: { name, permissions: permissions.map((key) => ({ permission: { key } })) },
});

const user = (overrides: Record<string, unknown> = {}) => ({
  id: 'usr_1',
  isActive: true,
  isSuperAdmin: false,
  memberships: [
    {
      organizationId: 'org_a',
      status: 'ACTIVE',
      roles: [role('operator', ['payment.read', 'payment.create'])],
    },
  ],
  ...overrides,
});

describe('resolving what a subject holds', () => {
  it('returns the roles and permissions of an active membership', async () => {
    const resolver = new PrismaAccessResolver({ prisma: store(user()) });

    expect(await resolver.resolve('usr_1', 'org_a')).toEqual({
      roles: ['operator'],
      permissions: ['payment.create', 'payment.read'],
      isSuperAdmin: false,
    });
  });

  it('deduplicates a permission granted by two roles', async () => {
    const resolver = new PrismaAccessResolver({
      prisma: store(
        user({
          memberships: [
            {
              organizationId: 'org_a',
              status: 'ACTIVE',
              roles: [role('operator', ['payment.read']), role('auditor', ['payment.read'])],
            },
          ],
        }),
      ),
    });

    const access = await resolver.resolve('usr_1', 'org_a');

    expect(access?.permissions).toEqual(['payment.read']);
    expect(access?.roles).toEqual(['auditor', 'operator']);
  });

  it('matches the identity provider subject before the local id', async () => {
    const spy = store(user());
    await new PrismaAccessResolver({ prisma: spy }).resolve('sub-from-keycloak', 'org_a');

    // Email is deliberately not in the query: it can be reassigned inside a directory,
    // and matching a reassignable value is how one person inherits another's access.
    expect(spy.lastWhere?.OR).toEqual([
      { externalId: 'sub-from-keycloak' },
      { id: 'sub-from-keycloak' },
    ]);
    expect(JSON.stringify(spy.lastWhere)).not.toContain('email');
  });

  it('excludes soft-deleted accounts in the query itself', async () => {
    const spy = store(user());
    await new PrismaAccessResolver({ prisma: spy }).resolve('usr_1', 'org_a');

    expect(spy.lastWhere?.deletedAt).toBeNull();
  });
});

describe('refusing', () => {
  it('resolves nothing for an unknown subject', async () => {
    const resolver = new PrismaAccessResolver({ prisma: store(null) });

    expect(await resolver.resolve('nobody', 'org_a')).toBeNull();
  });

  it('resolves nothing for a deactivated account', async () => {
    const resolver = new PrismaAccessResolver({ prisma: store(user({ isActive: false })) });

    expect(await resolver.resolve('usr_1', 'org_a')).toBeNull();
  });

  it('resolves nothing in an organization the subject is not a member of', async () => {
    const resolver = new PrismaAccessResolver({ prisma: store(user()) });

    // The membership exists — in org_a. Asking about org_b must not inherit it.
    expect(await resolver.resolve('usr_1', 'org_b')).toBeNull();
  });

  it('treats an invitation as not yet a membership', async () => {
    const resolver = new PrismaAccessResolver({
      prisma: store(
        user({
          memberships: [
            { organizationId: 'org_a', status: 'INVITED', roles: [role('operator', [])] },
          ],
        }),
      ),
    });

    // An invitation is an intent to grant access, not the grant.
    expect(await resolver.resolve('usr_1', 'org_a')).toBeNull();
  });

  it('returns null rather than empty roles, so "not a member" stays distinguishable', async () => {
    const resolver = new PrismaAccessResolver({ prisma: store(user()) });

    // Empty roles would let the request proceed as a member holding nothing. The
    // authenticator turns null into a refusal, which is the different — and correct —
    // outcome.
    expect(await resolver.resolve('usr_1', 'org_b')).not.toEqual({
      roles: [],
      permissions: [],
      isSuperAdmin: false,
    });
  });
});

describe('platform staff', () => {
  it('reports super-admin without inventing roles', async () => {
    const resolver = new PrismaAccessResolver({
      prisma: store(user({ isSuperAdmin: true, memberships: [] })),
    });

    // The bypass belongs in the permission check. Handing out a role nobody granted
    // would make an audit record claim an assignment that does not exist.
    expect(await resolver.resolve('usr_1', 'org_a')).toEqual({
      roles: [],
      permissions: [],
      isSuperAdmin: true,
    });
  });

  it('does not let a non-staff subject reach an organization it has no membership in', async () => {
    const resolver = new PrismaAccessResolver({
      prisma: store(user({ isSuperAdmin: false, memberships: [] })),
    });

    expect(await resolver.resolve('usr_1', 'org_a')).toBeNull();
  });

  it('reports staff status for a platform-level request naming no organization', async () => {
    const resolver = new PrismaAccessResolver({ prisma: store(user({ isSuperAdmin: true })) });

    expect(await resolver.resolve('usr_1', null)).toEqual({
      roles: [],
      permissions: [],
      isSuperAdmin: true,
    });
  });

  it('reports a plain account as not staff for a platform-level request', async () => {
    const resolver = new PrismaAccessResolver({ prisma: store(user()) });

    expect(await resolver.resolve('usr_1', null)).toEqual({
      roles: [],
      permissions: [],
      isSuperAdmin: false,
    });
  });
});

describe('configuration', () => {
  it('accepts a deployment that counts another status as active', async () => {
    const resolver = new PrismaAccessResolver({
      prisma: store(
        user({
          memberships: [
            { organizationId: 'org_a', status: 'PROVISIONAL', roles: [role('viewer', ['x.read'])] },
          ],
        }),
      ),
      activeStatuses: ['ACTIVE', 'PROVISIONAL'],
    });

    expect((await resolver.resolve('usr_1', 'org_a'))?.roles).toEqual(['viewer']);
  });

  it('does not count that status when the deployment has not asked for it', async () => {
    const resolver = new PrismaAccessResolver({
      prisma: store(
        user({
          memberships: [
            { organizationId: 'org_a', status: 'PROVISIONAL', roles: [role('viewer', ['x.read'])] },
          ],
        }),
      ),
    });

    expect(await resolver.resolve('usr_1', 'org_a')).toBeNull();
  });
});
