/**
 * TrustOS Customer Portal — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const CUSTOMER_PORTAL_PERMISSIONS = {
  PORTAL_PROFILE_READ: definePermission('customerportal.portal-profile.read', 'View profiles.'),
  PORTAL_PROFILE_CREATE: definePermission(
    'customerportal.portal-profile.create',
    'Create profile.',
  ),
  PORTAL_PROFILE_UPDATE: definePermission(
    'customerportal.portal-profile.update',
    'Modify profile.',
  ),
  PORTAL_PROFILE_PII_READ: definePermission(
    'customerportal.portal-profile.pii.read',
    'See personal data on profiles (email, phone).',
  ),
  PORTAL_DOCUMENT_READ: definePermission('customerportal.portal-document.read', 'View documents.'),
  PORTAL_DOCUMENT_CREATE: definePermission(
    'customerportal.portal-document.create',
    'Create document.',
  ),
  PORTAL_DOCUMENT_UPDATE: definePermission(
    'customerportal.portal-document.update',
    'Modify document.',
  ),
  PORTAL_NOTIFICATION_READ: definePermission(
    'customerportal.portal-notification.read',
    'View notifications.',
  ),
  PORTAL_NOTIFICATION_CREATE: definePermission(
    'customerportal.portal-notification.create',
    'Create notification.',
  ),
  PORTAL_NOTIFICATION_UPDATE: definePermission(
    'customerportal.portal-notification.update',
    'Modify notification.',
  ),
  SUPPORT_REQUEST_READ: definePermission(
    'customerportal.support-request.read',
    'View support requests.',
  ),
  SUPPORT_REQUEST_CREATE: definePermission(
    'customerportal.support-request.create',
    'Create support request.',
  ),
  SUPPORT_REQUEST_UPDATE: definePermission(
    'customerportal.support-request.update',
    'Modify support request.',
  ),
} as const;

export const CUSTOMER_PORTAL_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(
  CUSTOMER_PORTAL_PERMISSIONS,
);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_PROFILE_READ.key,
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_DOCUMENT_READ.key,
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_NOTIFICATION_READ.key,
  CUSTOMER_PORTAL_PERMISSIONS.SUPPORT_REQUEST_READ.key,
];

const WRITE = [
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_PROFILE_CREATE.key,
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_PROFILE_UPDATE.key,
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_DOCUMENT_CREATE.key,
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_DOCUMENT_UPDATE.key,
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_NOTIFICATION_CREATE.key,
  CUSTOMER_PORTAL_PERMISSIONS.PORTAL_NOTIFICATION_UPDATE.key,
  CUSTOMER_PORTAL_PERMISSIONS.SUPPORT_REQUEST_CREATE.key,
  CUSTOMER_PORTAL_PERMISSIONS.SUPPORT_REQUEST_UPDATE.key,
];

/** Personal data. Granted to nobody by default except the owner role. */
const PERSONAL_DATA = [CUSTOMER_PORTAL_PERMISSIONS.PORTAL_PROFILE_PII_READ.key];

export const CUSTOMER_PORTAL_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: CUSTOMER_PORTAL_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE, ...PERSONAL_DATA],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type DocumentCategory = 'STATEMENT' | 'CONTRACT' | 'INVOICE' | 'IDENTITY' | 'OTHER';
export const DOCUMENT_CATEGORY_VALUES: DocumentCategory[] = [
  'STATEMENT',
  'CONTRACT',
  'INVOICE',
  'IDENTITY',
  'OTHER',
];

export type SupportStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
export const SUPPORT_STATUS_VALUES: SupportStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ON_CUSTOMER',
  'RESOLVED',
  'CLOSED',
];
