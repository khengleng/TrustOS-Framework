/**
 * TrustOS Messenger Mini App — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const MESSENGER_MINIAPP_PERMISSIONS = {
  MESSENGER_PROFILE_READ: definePermission(
    'messengerminiapp.messenger-profile.read',
    'View messenger profiles.',
  ),
  MESSENGER_PROFILE_CREATE: definePermission(
    'messengerminiapp.messenger-profile.create',
    'Create messenger profile.',
  ),
  MESSENGER_PROFILE_UPDATE: definePermission(
    'messengerminiapp.messenger-profile.update',
    'Modify messenger profile.',
  ),
} as const;

export const MESSENGER_MINIAPP_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(
  MESSENGER_MINIAPP_PERMISSIONS,
);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [MESSENGER_MINIAPP_PERMISSIONS.MESSENGER_PROFILE_READ.key];

const WRITE = [
  MESSENGER_MINIAPP_PERMISSIONS.MESSENGER_PROFILE_CREATE.key,
  MESSENGER_MINIAPP_PERMISSIONS.MESSENGER_PROFILE_UPDATE.key,
];

export const MESSENGER_MINIAPP_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: MESSENGER_MINIAPP_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};
