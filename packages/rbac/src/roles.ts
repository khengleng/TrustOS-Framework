import { PERMISSIONS, WILDCARD_PERMISSION, type PermissionDefinition } from './permissions';

/**
 * System roles.
 *
 * Fixed ids make the seed idempotent and make a role reference stable across
 * environments. Permission sets follow least privilege: each role holds the
 * narrowest set that lets its holder do the job, and nothing is granted
 * "because an admin will probably need it".
 */

export const SYSTEM_ROLE_NAMES = [
  'super_admin',
  'organization_owner',
  'administrator',
  'operator',
  'auditor',
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number];

export interface SystemRoleDefinition {
  /** Stable primary key, so `upsert` by id is idempotent. */
  id: string;
  name: SystemRoleName;
  description: string;
  permissions: string[];
  /**
   * Roles a holder is allowed to grant. Prevents an administrator from
   * promoting someone (or themselves) to organization_owner, which is the
   * usual privilege-escalation path in a role system.
   */
  grantableRoles: SystemRoleName[];
}

const keys = (...definitions: PermissionDefinition[]): string[] =>
  definitions.map((definition) => definition.key);

export const SYSTEM_ROLES: Record<SystemRoleName, SystemRoleDefinition> = {
  super_admin: {
    id: 'role_sys_super_admin',
    name: 'super_admin',
    description: 'Platform staff. Operates across every organization.',
    permissions: [WILDCARD_PERMISSION],
    grantableRoles: ['organization_owner', 'administrator', 'operator', 'auditor'],
  },

  organization_owner: {
    id: 'role_sys_organization_owner',
    name: 'organization_owner',
    description: 'Owns a single organization and everything inside it.',
    permissions: keys(
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.ORGANIZATION_UPDATE,
      PERMISSIONS.MEMBER_READ,
      PERMISSIONS.MEMBER_INVITE,
      PERMISSIONS.MEMBER_REMOVE,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.ROLE_ASSIGN,
      PERMISSIONS.ROLE_REVOKE,
      PERMISSIONS.ROLE_MANAGE,
      PERMISSIONS.PERMISSION_READ,
      PERMISSIONS.USER_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.CONFIG_READ,
      PERMISSIONS.CONFIG_UPDATE,
    ),
    grantableRoles: ['organization_owner', 'administrator', 'operator', 'auditor'],
  },

  administrator: {
    id: 'role_sys_administrator',
    name: 'administrator',
    description: 'Day-to-day administration. Cannot change billing-grade settings or ownership.',
    permissions: keys(
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.MEMBER_READ,
      PERMISSIONS.MEMBER_INVITE,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.ROLE_ASSIGN,
      PERMISSIONS.ROLE_REVOKE,
      PERMISSIONS.PERMISSION_READ,
      PERMISSIONS.USER_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.CONFIG_READ,
    ),
    // Deliberately cannot grant organization_owner or administrator.
    grantableRoles: ['operator', 'auditor'],
  },

  operator: {
    id: 'role_sys_operator',
    name: 'operator',
    description: 'Performs routine operational work. Read-only over people and settings.',
    permissions: keys(
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.MEMBER_READ,
      PERMISSIONS.USER_READ,
    ),
    grantableRoles: [],
  },

  auditor: {
    id: 'role_sys_auditor',
    name: 'auditor',
    description: 'Read-only oversight, including the audit trail. Changes nothing.',
    permissions: keys(
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.MEMBER_READ,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.AUDIT_READ,
    ),
    grantableRoles: [],
  },
};

export const SYSTEM_ROLE_LIST: SystemRoleDefinition[] = Object.values(SYSTEM_ROLES);

/** The role a brand-new organization's creator receives. */
export const ORGANIZATION_CREATOR_ROLE: SystemRoleName = 'organization_owner';

/**
 * The role assigned to an invited member when the caller does not specify one.
 * The least-privileged role in the catalog, on purpose.
 */
export const DEFAULT_MEMBER_ROLE: SystemRoleName = 'operator';

export function isSystemRoleName(value: string): value is SystemRoleName {
  return (SYSTEM_ROLE_NAMES as readonly string[]).includes(value);
}

/**
 * Whether a holder of `holderRoles` may grant `targetRole`.
 *
 * Used by the role-assignment endpoint. Without this check, `rbac.role.assign`
 * is effectively `platform.admin`: anyone who can assign roles can assign the
 * most powerful one.
 */
export function canGrantRole(holderRoles: string[], targetRole: string): boolean {
  return holderRoles.some((roleName) => {
    if (!isSystemRoleName(roleName)) return false;
    return (SYSTEM_ROLES[roleName].grantableRoles as string[]).includes(targetRole);
  });
}
