/**
 * TrustOS Staff Portal — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const STAFF_PORTAL_PERMISSIONS = {
  STAFF_PROFILE_READ: definePermission('staffportal.staff-profile.read', 'View staff.'),
  STAFF_PROFILE_CREATE: definePermission(
    'staffportal.staff-profile.create',
    'Create staff member.',
  ),
  STAFF_PROFILE_UPDATE: definePermission(
    'staffportal.staff-profile.update',
    'Modify staff member.',
  ),
  STAFF_TASK_READ: definePermission('staffportal.staff-task.read', 'View tasks.'),
  STAFF_TASK_CREATE: definePermission('staffportal.staff-task.create', 'Create task.'),
  STAFF_TASK_UPDATE: definePermission('staffportal.staff-task.update', 'Modify task.'),
  SAVED_SEARCH_READ: definePermission('staffportal.saved-search.read', 'View saved searches.'),
  SAVED_SEARCH_CREATE: definePermission('staffportal.saved-search.create', 'Create saved search.'),
  SAVED_SEARCH_UPDATE: definePermission('staffportal.saved-search.update', 'Modify saved search.'),
  STAFF_NOTIFICATION_READ: definePermission(
    'staffportal.staff-notification.read',
    'View notifications.',
  ),
  STAFF_NOTIFICATION_CREATE: definePermission(
    'staffportal.staff-notification.create',
    'Create notification.',
  ),
  STAFF_NOTIFICATION_UPDATE: definePermission(
    'staffportal.staff-notification.update',
    'Modify notification.',
  ),
} as const;

export const STAFF_PORTAL_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(STAFF_PORTAL_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  STAFF_PORTAL_PERMISSIONS.STAFF_PROFILE_READ.key,
  STAFF_PORTAL_PERMISSIONS.STAFF_TASK_READ.key,
  STAFF_PORTAL_PERMISSIONS.SAVED_SEARCH_READ.key,
  STAFF_PORTAL_PERMISSIONS.STAFF_NOTIFICATION_READ.key,
];

const WRITE = [
  STAFF_PORTAL_PERMISSIONS.STAFF_PROFILE_CREATE.key,
  STAFF_PORTAL_PERMISSIONS.STAFF_PROFILE_UPDATE.key,
  STAFF_PORTAL_PERMISSIONS.STAFF_TASK_CREATE.key,
  STAFF_PORTAL_PERMISSIONS.STAFF_TASK_UPDATE.key,
  STAFF_PORTAL_PERMISSIONS.SAVED_SEARCH_CREATE.key,
  STAFF_PORTAL_PERMISSIONS.SAVED_SEARCH_UPDATE.key,
  STAFF_PORTAL_PERMISSIONS.STAFF_NOTIFICATION_CREATE.key,
  STAFF_PORTAL_PERMISSIONS.STAFF_NOTIFICATION_UPDATE.key,
];

export const STAFF_PORTAL_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: STAFF_PORTAL_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type StaffTaskPriority = 'LOW' | 'NORMAL' | 'HIGH';
export const STAFF_TASK_PRIORITY_VALUES: StaffTaskPriority[] = ['LOW', 'NORMAL', 'HIGH'];

export type StaffTaskStatus = 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';
export const STAFF_TASK_STATUS_VALUES: StaffTaskStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'DONE',
  'CANCELLED',
];
