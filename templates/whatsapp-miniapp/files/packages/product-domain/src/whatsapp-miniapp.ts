/**
 * TrustOS WhatsApp Mini App — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const WHATSAPP_MINIAPP_PERMISSIONS = {
  WHATS_APP_PROFILE_READ: definePermission(
    'whatsappminiapp.whats-app-profile.read',
    'View whatsapp profiles.',
  ),
  WHATS_APP_PROFILE_CREATE: definePermission(
    'whatsappminiapp.whats-app-profile.create',
    'Create whatsapp profile.',
  ),
  WHATS_APP_PROFILE_UPDATE: definePermission(
    'whatsappminiapp.whats-app-profile.update',
    'Modify whatsapp profile.',
  ),
  WHATS_APP_PROFILE_PII_READ: definePermission(
    'whatsappminiapp.whats-app-profile.pii.read',
    'See personal data on whatsapp profiles (phone).',
  ),
} as const;

export const WHATSAPP_MINIAPP_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(
  WHATSAPP_MINIAPP_PERMISSIONS,
);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [WHATSAPP_MINIAPP_PERMISSIONS.WHATS_APP_PROFILE_READ.key];

const WRITE = [
  WHATSAPP_MINIAPP_PERMISSIONS.WHATS_APP_PROFILE_CREATE.key,
  WHATSAPP_MINIAPP_PERMISSIONS.WHATS_APP_PROFILE_UPDATE.key,
];

/** Personal data. Granted to nobody by default except the owner role. */
const PERSONAL_DATA = [WHATSAPP_MINIAPP_PERMISSIONS.WHATS_APP_PROFILE_PII_READ.key];

export const WHATSAPP_MINIAPP_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: WHATSAPP_MINIAPP_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE, ...PERSONAL_DATA],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};
