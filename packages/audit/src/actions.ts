/**
 * Audit action catalog.
 *
 * Action keys are permanent. A dashboard, an alert rule or a regulator's
 * export may reference `auth.login` for years, so keys are added, never
 * renamed. Products extend this catalog with their own namespace
 * (`payments.refund.issued`) rather than reusing framework keys.
 */

export const AUDIT_ACTIONS = {
  // Authentication
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  LOGOUT: 'auth.logout',
  TOKEN_REFRESHED: 'auth.token_refreshed',
  TOKEN_REUSE_DETECTED: 'auth.token_reuse_detected',
  SESSIONS_REVOKED: 'auth.sessions_revoked',
  ORGANIZATION_SELECTED: 'auth.organization_selected',
  PASSWORD_REHASHED: 'auth.password_rehashed',

  // Users
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',

  // Organizations and membership
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  MEMBER_INVITED: 'organization.member.invited',
  MEMBER_JOINED: 'organization.member.joined',
  MEMBER_REMOVED: 'organization.member.removed',

  // Authorization
  ROLE_ASSIGNED: 'rbac.role.assigned',
  ROLE_REVOKED: 'rbac.role.revoked',
  ROLE_CREATED: 'rbac.role.created',
  PERMISSION_CHANGED: 'rbac.permission.changed',

  // Configuration
  CONFIGURATION_CHANGED: 'config.changed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Entity types referenced by framework audit records. Products add their own.
 * Kept as string literals rather than an enum so a product can pass its own
 * entity name without patching the framework.
 */
export const AUDIT_ENTITY = {
  USER: 'User',
  ORGANIZATION: 'Organization',
  ORGANIZATION_MEMBER: 'OrganizationMember',
  ROLE: 'Role',
  PERMISSION: 'Permission',
  REFRESH_TOKEN: 'RefreshToken',
  CONFIGURATION: 'Configuration',
} as const;
