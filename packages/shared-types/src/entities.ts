import type {
  AuditLogId,
  IsoDateTime,
  MembershipId,
  OrganizationId,
  RequestId,
  RoleId,
  Timestamped,
  UserId,
} from './ids';

/** A user as it is safe to expose over the API. Never carries credential material. */
export interface UserSummary extends Timestamped {
  id: UserId;
  email: string;
  displayName: string | null;
  isActive: boolean;
  lastLoginAt: IsoDateTime | null;
}

export interface OrganizationSummary extends Timestamped {
  id: OrganizationId;
  name: string;
  slug: string;
  isActive: boolean;
}

export type MembershipStatus = 'invited' | 'active' | 'suspended';

export interface OrganizationMemberSummary extends Timestamped {
  id: MembershipId;
  organizationId: OrganizationId;
  user: UserSummary;
  status: MembershipStatus;
  roles: RoleSummary[];
  invitedAt: IsoDateTime | null;
  joinedAt: IsoDateTime | null;
}

export interface RoleSummary {
  id: RoleId;
  name: string;
  description: string | null;
  /** System roles ship with the framework and cannot be renamed or deleted. */
  isSystem: boolean;
  /** `null` for system roles, which are shared across every organization. */
  organizationId: OrganizationId | null;
  permissions: string[];
}

/**
 * An audit record as returned to authorized readers. `before`/`after` are
 * already redacted server-side — see @trustos/audit.
 */
export interface AuditLogEntry {
  id: AuditLogId;
  action: string;
  entityType: string;
  entityId: string | null;
  actorId: UserId | null;
  organizationId: OrganizationId | null;
  before: unknown;
  after: unknown;
  requestId: RequestId | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: IsoDateTime;
}

/** The identity payload the API returns alongside a token pair. */
export interface AuthenticatedUser {
  user: UserSummary;
  organizations: OrganizationSummary[];
}
