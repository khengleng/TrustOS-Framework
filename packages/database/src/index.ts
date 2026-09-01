/**
 * @trustsystem/database
 *
 * Owns the Prisma schema, the client lifecycle, and the conventions
 * (soft delete, tenant columns) that the rest of the framework relies on.
 *
 * Product code should depend on this package for the *client*, and on
 * @trustsystem/tenancy for *how to scope a query* — the two concerns are kept
 * apart so tenant rules cannot be quietly bypassed by reaching for the raw
 * client.
 */
export { Prisma, PrismaClient, MembershipStatus } from '@prisma/client';
export type {
  User,
  Organization,
  OrganizationMember,
  OrganizationMemberRole,
  Role,
  Permission,
  RolePermission,
  RefreshToken,
  AuditLog,
} from '@prisma/client';

export * from './prisma-client';
export * from './prisma.service';
export * from './database.module';
export * from './soft-delete';
export * from './tokens';
