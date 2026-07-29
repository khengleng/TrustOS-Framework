/**
 * The framework permission catalog.
 *
 * Keys are `resource.action` (or `resource.subresource.action`) and are part
 * of the public contract: add keys freely, never rename or repurpose one — a
 * renamed key silently grants or revokes access on every deployment that has
 * not been migrated.
 *
 * Product packages define their own catalog and merge it in; see
 * templates/saas-starter for the pattern.
 */

export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): PermissionDefinition {
  const segments = key.split('.');
  const action = segments[segments.length - 1] as string;
  const resource = segments.slice(0, -1).join('.');
  return { key, resource, action, description };
}

export const PERMISSIONS = {
  ORGANIZATION_READ: define('organization.read', 'View organization details.'),
  ORGANIZATION_CREATE: define('organization.create', 'Create a new organization.'),
  ORGANIZATION_UPDATE: define('organization.update', 'Change organization settings.'),

  MEMBER_READ: define('organization.member.read', 'List organization members.'),
  MEMBER_INVITE: define('organization.member.invite', 'Invite a member to the organization.'),
  MEMBER_REMOVE: define('organization.member.remove', 'Remove a member from the organization.'),

  ROLE_READ: define('rbac.role.read', 'View roles and their permissions.'),
  ROLE_ASSIGN: define('rbac.role.assign', 'Assign a role to a member.'),
  ROLE_REVOKE: define('rbac.role.revoke', 'Revoke a role from a member.'),
  ROLE_MANAGE: define('rbac.role.manage', 'Create or modify organization roles.'),
  PERMISSION_READ: define('rbac.permission.read', 'View the permission catalog.'),

  USER_READ: define('user.read', 'View user profiles.'),
  USER_CREATE: define('user.create', 'Create user accounts.'),
  USER_UPDATE: define('user.update', 'Modify user accounts.'),

  AUDIT_READ: define('audit.read', 'Read the audit trail.'),

  CONFIG_READ: define('config.read', 'View application configuration.'),
  CONFIG_UPDATE: define('config.update', 'Change application configuration.'),

  /** Platform staff only. Never granted to an organization role. */
  PLATFORM_ADMIN: define('platform.admin', 'Operate across every organization.'),
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]['key'];

export const ALL_PERMISSIONS: PermissionDefinition[] = Object.values(PERMISSIONS);

export const ALL_PERMISSION_KEYS: string[] = ALL_PERMISSIONS.map((permission) => permission.key);

/** The wildcard grant. Only `super_admin` holds it. */
export const WILDCARD_PERMISSION = '*';

export function isKnownPermission(key: string): boolean {
  return key === WILDCARD_PERMISSION || ALL_PERMISSION_KEYS.includes(key);
}
