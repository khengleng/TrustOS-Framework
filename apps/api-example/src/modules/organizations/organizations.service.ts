import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_ACTIONS, AUDIT_ENTITY, type AuditService } from '@trustsystem/audit';
import { MembershipStatus, PrismaService } from '@trustsystem/database';
import { ApiError } from '@trustsystem/errors';
import {
  DEFAULT_MEMBER_ROLE,
  ORGANIZATION_CREATOR_ROLE,
  SYSTEM_ROLES,
  canGrantRole,
  isSystemRoleName,
} from '@trustsystem/rbac';
import { assertTenantMatch } from '@trustsystem/tenancy';
import type {
  ActorContext,
  OrganizationMemberSummary,
  OrganizationSummary,
  RoleSummary,
} from '@trustsystem/shared-types';
import { slugify } from '@trustsystem/validation';
import { AUDIT_SERVICE } from '../../tokens';

const MEMBER_INCLUDE = {
  user: true,
  roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
} as const;

/**
 * Organization and membership management.
 *
 * Every method takes `organizationId` explicitly rather than reading it from
 * ambient state. The tenant guard has already pinned it, and passing it makes
 * the scope visible in every signature — which is what stops a future refactor
 * from quietly dropping it.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /**
   * Creates an organization and makes `ownerUserId` its owner.
   *
   * One transaction: an organization without an owner is unreachable — nobody
   * holds the permissions needed to invite the first member — so a partial
   * success here would leave orphaned rows that require manual repair.
   */
  async create(
    input: { name: string; slug?: string },
    ownerUserId: string,
  ): Promise<OrganizationSummary> {
    const slug = await this.uniqueSlug(input.slug ?? slugify(input.name));
    const ownerRole = SYSTEM_ROLES[ORGANIZATION_CREATOR_ROLE];

    const organization = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name: input.name.trim(), slug } });

      const membership = await tx.organizationMember.create({
        data: {
          organizationId: created.id,
          userId: ownerUserId,
          status: MembershipStatus.ACTIVE,
          joinedAt: new Date(),
        },
      });

      await tx.organizationMemberRole.create({
        data: { memberId: membership.id, roleId: ownerRole.id, assignedById: ownerUserId },
      });

      return created;
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.ORGANIZATION_CREATED,
      entityType: AUDIT_ENTITY.ORGANIZATION,
      entityId: organization.id,
      actorId: ownerUserId,
      organizationId: organization.id,
      after: { name: organization.name, slug: organization.slug, ownerUserId },
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.ROLE_ASSIGNED,
      entityType: AUDIT_ENTITY.ORGANIZATION_MEMBER,
      entityId: ownerUserId,
      actorId: ownerUserId,
      organizationId: organization.id,
      after: { roles: [ownerRole.name], reason: 'organization_created' },
    });

    return toOrganizationSummary(organization);
  }

  async listMembers(organizationId: string): Promise<OrganizationMemberSummary[]> {
    const members = await this.prisma.organizationMember.findMany({
      // The tenant filter is the first condition on every read of a
      // tenant-owned table. `deletedAt` keeps retired rows out.
      where: { organizationId, deletedAt: null },
      include: MEMBER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    return members.map(toMemberSummary);
  }

  /**
   * Invites someone to the organization.
   *
   * If no account exists, one is created with an unusable password: the
   * invitee cannot sign in until they set a password, and no temporary
   * credential is ever transmitted or stored.
   */
  async invite(
    organizationId: string,
    input: { email: string; roleName?: string },
    actor: ActorContext,
  ): Promise<OrganizationMemberSummary> {
    const roleName = input.roleName ?? DEFAULT_MEMBER_ROLE;
    this.assertMayGrant(actor, roleName);
    const role = await this.requireAssignableRole(organizationId, roleName);

    const existingUser = await this.prisma.user.findFirst({
      where: { email: input.email, deletedAt: null },
    });

    const membership = await this.prisma.$transaction(async (tx) => {
      const user =
        existingUser ??
        (await tx.user.create({
          data: {
            email: input.email,
            // 48 random bytes bcrypt-formatted is not a password anyone can
            // present; it is a placeholder that fails every comparison.
            passwordHash: `$2a$12$${randomBytes(48).toString('base64url')}`,
            isActive: true,
          },
        }));

      const existingMembership = await tx.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId: user.id } },
      });

      if (existingMembership && existingMembership.deletedAt === null) {
        throw ApiError.conflict('That person is already a member of this organization.');
      }

      const created = existingMembership
        ? await tx.organizationMember.update({
            where: { id: existingMembership.id },
            data: {
              deletedAt: null,
              status: MembershipStatus.INVITED,
              invitedAt: new Date(),
              invitedById: actor.userId,
            },
            include: MEMBER_INCLUDE,
          })
        : await tx.organizationMember.create({
            data: {
              organizationId,
              userId: user.id,
              status: MembershipStatus.INVITED,
              invitedAt: new Date(),
              invitedById: actor.userId,
            },
            include: MEMBER_INCLUDE,
          });

      await tx.organizationMemberRole.upsert({
        where: { memberId_roleId: { memberId: created.id, roleId: role.id } },
        create: { memberId: created.id, roleId: role.id, assignedById: actor.userId },
        update: {},
      });

      return tx.organizationMember.findUniqueOrThrow({
        where: { id: created.id },
        include: MEMBER_INCLUDE,
      });
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.MEMBER_INVITED,
      entityType: AUDIT_ENTITY.ORGANIZATION_MEMBER,
      entityId: membership.id,
      organizationId,
      after: { email: input.email, role: roleName, userExisted: Boolean(existingUser) },
    });

    return toMemberSummary(membership);
  }

  /**
   * Replaces a member's roles with a single role.
   *
   * Two authorization checks apply beyond the `rbac.role.assign` permission:
   * the member must belong to the caller's organization, and the caller must
   * be allowed to grant that particular role (`canGrantRole`). Without the
   * second check, anyone who can assign roles can make themselves an owner.
   */
  async assignRole(
    organizationId: string,
    memberId: string,
    roleName: string,
    actor: ActorContext,
  ): Promise<OrganizationMemberSummary> {
    this.assertMayGrant(actor, roleName);
    const role = await this.requireAssignableRole(organizationId, roleName);

    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: MEMBER_INCLUDE,
    });

    // Belt and braces: the lookup is by primary key, so the tenant check
    // cannot be part of the query. A member from another organization is
    // reported as not_found, exactly like one that does not exist.
    const scoped = assertTenantMatch(member, organizationId);

    const previousRoles = scoped.roles.map((assignment) => assignment.role.name);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.organizationMemberRole.deleteMany({ where: { memberId: scoped.id } });
      await tx.organizationMemberRole.create({
        data: { memberId: scoped.id, roleId: role.id, assignedById: actor.userId },
      });
      return tx.organizationMember.findUniqueOrThrow({
        where: { id: scoped.id },
        include: MEMBER_INCLUDE,
      });
    });

    await this.audit.record({
      action: AUDIT_ACTIONS.ROLE_ASSIGNED,
      entityType: AUDIT_ENTITY.ORGANIZATION_MEMBER,
      entityId: scoped.id,
      organizationId,
      before: { roles: previousRoles },
      after: { roles: [roleName] },
    });

    return toMemberSummary(updated);
  }

  /** System roles plus any roles this organization defined for itself. */
  async listRoles(organizationId: string): Promise<RoleSummary[]> {
    const roles = await this.prisma.role.findMany({
      where: { deletedAt: null, OR: [{ isSystem: true }, { organizationId }] },
      include: { permissions: { include: { permission: true } } },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });

    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      organizationId: role.organizationId,
      permissions: role.permissions.map((entry) => entry.permission.key),
    }));
  }

  async findById(organizationId: string): Promise<OrganizationSummary> {
    const organization = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
    if (!organization) throw ApiError.notFound();
    return toOrganizationSummary(organization);
  }

  // ---------------------------------------------------------------------------

  private assertMayGrant(actor: ActorContext, roleName: string): void {
    if (actor.isSuperAdmin) return;
    if (!canGrantRole(actor.roles, roleName)) {
      throw ApiError.forbidden('You cannot grant that role.', {
        reason: 'role_not_grantable',
        actorRoles: actor.roles,
        requestedRole: roleName,
      });
    }
  }

  private async requireAssignableRole(
    organizationId: string,
    roleName: string,
  ): Promise<{ id: string; name: string }> {
    // `super_admin` is a platform flag on the user, not something an
    // organization can hand out.
    if (roleName === 'super_admin') {
      throw ApiError.forbidden('That role cannot be assigned through this endpoint.', {
        reason: 'role_not_assignable',
        requestedRole: roleName,
      });
    }

    const role = await this.prisma.role.findFirst({
      where: {
        name: roleName,
        deletedAt: null,
        OR: [{ isSystem: true }, { organizationId }],
      },
    });

    if (!role) {
      throw ApiError.notFound('No such role.', { requestedRole: roleName, organizationId });
    }
    if (!role.isSystem && role.organizationId !== organizationId) {
      throw ApiError.notFound('No such role.', { requestedRole: roleName, organizationId });
    }
    if (role.isSystem && !isSystemRoleName(role.name)) {
      throw ApiError.internal('System role is not present in the framework catalog.');
    }

    return role;
  }

  /** Appends a short suffix rather than failing when a slug is taken. */
  private async uniqueSlug(base: string): Promise<string> {
    const candidate = base || 'organization';
    const taken = await this.prisma.organization.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
    return `${candidate}-${randomBytes(3).toString('hex')}`;
  }
}

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toOrganizationSummary(organization: OrganizationRow): OrganizationSummary {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    isActive: organization.isActive,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

type MemberRow = {
  id: string;
  organizationId: string;
  status: MembershipStatus;
  invitedAt: Date | null;
  joinedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    isActive: boolean;
    lastLoginAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  roles: Array<{
    role: {
      id: string;
      name: string;
      description: string | null;
      isSystem: boolean;
      organizationId: string | null;
      permissions: Array<{ permission: { key: string } }>;
    };
  }>;
};

function toMemberSummary(member: MemberRow): OrganizationMemberSummary {
  return {
    id: member.id,
    organizationId: member.organizationId,
    status: member.status.toLowerCase() as OrganizationMemberSummary['status'],
    invitedAt: member.invitedAt?.toISOString() ?? null,
    joinedAt: member.joinedAt?.toISOString() ?? null,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
    user: {
      id: member.user.id,
      email: member.user.email,
      displayName: member.user.displayName,
      isActive: member.user.isActive,
      lastLoginAt: member.user.lastLoginAt?.toISOString() ?? null,
      createdAt: member.user.createdAt.toISOString(),
      updatedAt: member.user.updatedAt.toISOString(),
    },
    roles: member.roles.map((assignment) => ({
      id: assignment.role.id,
      name: assignment.role.name,
      description: assignment.role.description,
      isSystem: assignment.role.isSystem,
      organizationId: assignment.role.organizationId,
      permissions: assignment.role.permissions.map((entry) => entry.permission.key),
    })),
  };
}
