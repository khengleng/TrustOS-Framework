import type { AccessResolver } from '@trustsystem/identity';

/**
 * The minimum this needs from Prisma, so the package does not depend on the client.
 *
 * Structural rather than nominal: `@trustsystem/database` owns the generated client, and a
 * resolver that imported it would drag the whole schema into every consumer. A caller
 * passes `prisma` and the shapes line up.
 */
export interface AccessResolverStore {
  // Deliberately loose in its argument and narrow in its result: Prisma's generated
  // `findFirst` has a far more specific parameter type, and a structural interface that
  // insisted on the exact shape would reject the real client.
  user: { findFirst(args: never): Promise<unknown> };
}

interface UserRow {
  id: string;
  isActive: boolean;
  isSuperAdmin: boolean;
  memberships: MembershipRow[];
}

interface MembershipRow {
  organizationId: string;
  status: string;
  roles: { role: { name: string; permissions: { permission: { key: string } }[] } }[];
}

export interface PrismaAccessResolverOptions {
  prisma: AccessResolverStore;
  /**
   * Membership statuses that count as active.
   *
   * `ACTIVE` only, by default. An invited-but-not-joined member is deliberately not a
   * member: an invitation is a intent to grant access, not the grant.
   */
  activeStatuses?: string[];
}

/**
 * Resolves a verified subject to what it actually holds, from the database.
 *
 * Every application in this framework shipped a resolver that returned `null`, which
 * meant anyone below platform-root authenticated successfully and was then refused —
 * roles existed, memberships existed, and nothing connected the two. This is that
 * connection.
 *
 * Three properties are deliberate:
 *
 * **The subject is matched against `externalId` first, then `id`.** A person signing in
 * through an identity provider is found by the provider's stable `sub`; a local account
 * is found by its own id. Email is never matched on — it can be reassigned inside a
 * directory, and matching a reassignable value is how one person inherits another's
 * access.
 *
 * **Membership is read per request rather than trusted from the token.** That is a
 * lookup on every authenticated call, and it is the price of a revocation taking effect
 * now instead of whenever the access token happens to expire.
 *
 * **A subject with no membership in the named organization resolves to `null`**, which
 * the authenticator turns into a refusal. Returning empty roles instead would let the
 * request proceed as a member holding nothing, and "member with no permissions" and
 * "not a member" are different answers that should not be confused.
 */
export class PrismaAccessResolver implements AccessResolver {
  private readonly activeStatuses: string[];

  constructor(private readonly options: PrismaAccessResolverOptions) {
    this.activeStatuses = options.activeStatuses ?? ['ACTIVE'];
  }

  async resolve(
    subject: string,
    organizationId: string | null,
  ): Promise<{ roles: string[]; permissions: string[]; isSuperAdmin: boolean } | null> {
    const user = (await this.options.prisma.user.findFirst({
      where: {
        // Soft-deleted accounts are gone as far as authorization is concerned.
        deletedAt: null,
        OR: [{ externalId: subject }, { id: subject }],
      },
      select: {
        id: true,
        isActive: true,
        isSuperAdmin: true,
        memberships: {
          where: { deletedAt: null },
          select: {
            organizationId: true,
            status: true,
            roles: {
              select: {
                role: {
                  select: {
                    name: true,
                    permissions: { select: { permission: { select: { key: true } } } },
                  },
                },
              },
            },
          },
        },
      },
    } as never)) as UserRow | null;

    // A subject with no account, or a deactivated one, holds nothing. Returning null
    // rather than empty roles keeps "unknown" distinguishable from "known and empty".
    if (!user || !user.isActive) return null;

    /*
     * No organization named: this is a platform-level request.
     *
     * There is no membership to check, so the only thing to report is whether the
     * account is platform staff. `isSuperAdmin` is read from the framework's own record
     * rather than inferred from a token claim — the identity provider's mapped roles are
     * merged in separately by the authenticator, and requiring both to be server-side is
     * the point.
     */
    if (organizationId === null) {
      return { roles: [], permissions: [], isSuperAdmin: user.isSuperAdmin };
    }

    const membership = user.memberships.find(
      (entry) =>
        entry.organizationId === organizationId && this.activeStatuses.includes(entry.status),
    );

    /*
     * Platform staff are not members of every organization; they bypass the scope.
     *
     * Reported with no roles and no permissions, because a super admin holds neither —
     * the bypass happens in the permission check, not by handing out a role nobody
     * granted.
     */
    if (!membership) {
      return user.isSuperAdmin ? { roles: [], permissions: [], isSuperAdmin: true } : null;
    }

    const roles = [...new Set(membership.roles.map((assignment) => assignment.role.name))].sort();
    const permissions = [
      ...new Set(
        membership.roles.flatMap((assignment) =>
          assignment.role.permissions.map((entry) => entry.permission.key),
        ),
      ),
    ].sort();

    return { roles, permissions, isSuperAdmin: user.isSuperAdmin };
  }
}
