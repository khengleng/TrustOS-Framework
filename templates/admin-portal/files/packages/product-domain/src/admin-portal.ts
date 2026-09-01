/**
 * TrustOS Admin Portal — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const ADMIN_PORTAL_PERMISSIONS = {
  SYSTEM_SETTING_READ: definePermission('adminportal.system-setting.read', 'View configuration.'),
  SYSTEM_SETTING_CREATE: definePermission('adminportal.system-setting.create', 'Create setting.'),
  SYSTEM_SETTING_UPDATE: definePermission('adminportal.system-setting.update', 'Modify setting.'),
  OPERATOR_NOTE_READ: definePermission('adminportal.operator-note.read', 'View operator notes.'),
  OPERATOR_NOTE_CREATE: definePermission('adminportal.operator-note.create', 'Create note.'),
  OPERATOR_NOTE_UPDATE: definePermission('adminportal.operator-note.update', 'Modify note.'),
} as const;

export const ADMIN_PORTAL_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(ADMIN_PORTAL_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  ADMIN_PORTAL_PERMISSIONS.SYSTEM_SETTING_READ.key,
  ADMIN_PORTAL_PERMISSIONS.OPERATOR_NOTE_READ.key,
];

const WRITE = [
  ADMIN_PORTAL_PERMISSIONS.SYSTEM_SETTING_CREATE.key,
  ADMIN_PORTAL_PERMISSIONS.SYSTEM_SETTING_UPDATE.key,
  ADMIN_PORTAL_PERMISSIONS.OPERATOR_NOTE_CREATE.key,
  ADMIN_PORTAL_PERMISSIONS.OPERATOR_NOTE_UPDATE.key,
];

export const ADMIN_PORTAL_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: ADMIN_PORTAL_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};
