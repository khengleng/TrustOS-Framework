import { MembershipStatus, type PrismaClient } from '@trustos/database';
import { resolvePermissions } from '@trustos/rbac';
import type {
  AuthUserRecord,
  AuthUserStore,
  CreateUserInput,
  MembershipResolver,
  MembershipSummary,
  RefreshTokenRecord,
  RefreshTokenStore,
  RevocationReason,
  SaveRefreshTokenInput,
} from './ports';

/**
 * Prisma implementations of the auth storage ports.
 *
 * They live in the framework rather than in each product so that "an inactive
 * user cannot log in" and "a soft-deleted membership grants nothing" are
 * decided once. Every read here filters `deletedAt: null` — see
 * docs/security-standards.md.
 */

export class PrismaAuthUserStore implements AuthUserStore {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  async findById(userId: string): Promise<AuthUserRecord | null> {
    return this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  }

  async create(input: CreateUserInput): Promise<AuthUserRecord> {
    return this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
      },
    });
  }

  async recordLogin(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  async incrementTokenVersion(userId: string): Promise<number> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    return user.tokenVersion;
  }
}

export class PrismaRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly prisma: PrismaClient) {}

  async save(input: SaveRefreshTokenInput): Promise<void> {
    await this.prisma.refreshToken.create({ data: input });
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async revoke(
    tokenHash: string,
    reason: RevocationReason,
    replacedByHash?: string,
  ): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      // `revokedAt: null` makes this idempotent: re-revoking never overwrites
      // the original reason, which matters when investigating a reuse alert.
      where: { tokenHash, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: reason,
        ...(replacedByHash ? { replacedByHash } : {}),
      },
    });
  }

  async revokeFamily(familyId: string, reason: RevocationReason): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: RevocationReason): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Housekeeping for a scheduled job: drop tokens that expired long ago. */
  async pruneExpired(before: Date): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return result.count;
  }
}

const MEMBERSHIP_INCLUDE = {
  organization: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
} as const;

export class PrismaMembershipResolver implements MembershipResolver {
  constructor(private readonly prisma: PrismaClient) {}

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        status: MembershipStatus.ACTIVE,
        deletedAt: null,
        organization: { deletedAt: null, isActive: true },
      },
      include: MEMBERSHIP_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map(toMembershipSummary);
  }

  async resolveAccess(userId: string, organizationId: string): Promise<MembershipSummary | null> {
    const membership = await this.prisma.organizationMember.findFirst({
      where: {
        userId,
        organizationId,
        status: MembershipStatus.ACTIVE,
        deletedAt: null,
        organization: { deletedAt: null, isActive: true },
      },
      include: MEMBERSHIP_INCLUDE,
    });

    return membership ? toMembershipSummary(membership) : null;
  }
}

type MembershipRow = {
  organizationId: string;
  organization: { name: string; slug: string; isActive: boolean; createdAt: Date; updatedAt: Date };
  roles: Array<{
    role: {
      name: string;
      deletedAt: Date | null;
      permissions: Array<{ permission: { key: string } }>;
    };
  }>;
};

function toMembershipSummary(membership: MembershipRow): MembershipSummary {
  const roles = membership.roles
    .map((assignment) => assignment.role)
    .filter((role) => role.deletedAt === null);

  return {
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    organizationSlug: membership.organization.slug,
    organizationIsActive: membership.organization.isActive,
    organizationCreatedAt: membership.organization.createdAt,
    organizationUpdatedAt: membership.organization.updatedAt,
    roles: roles.map((role) => role.name),
    permissions: resolvePermissions(
      roles.map((role) => ({
        name: role.name,
        permissions: role.permissions.map((entry) => entry.permission.key),
      })),
    ),
  };
}
