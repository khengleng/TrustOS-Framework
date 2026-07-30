/**
 * TrustOS Digital Bank — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const DIGITAL_BANK_PERMISSIONS = {
  BANK_CUSTOMER_READ: definePermission('digitalbank.bank-customer.read', 'View customers.'),
  BANK_CUSTOMER_CREATE: definePermission('digitalbank.bank-customer.create', 'Create customer.'),
  BANK_CUSTOMER_UPDATE: definePermission('digitalbank.bank-customer.update', 'Modify customer.'),
  BANK_ACCOUNT_READ: definePermission('digitalbank.bank-account.read', 'View accounts.'),
  BANK_ACCOUNT_CREATE: definePermission('digitalbank.bank-account.create', 'Create account.'),
  BANK_ACCOUNT_UPDATE: definePermission('digitalbank.bank-account.update', 'Modify account.'),
  ACCOUNT_STATEMENT_READ: definePermission(
    'digitalbank.account-statement.read',
    'View statements.',
  ),
  ACCOUNT_STATEMENT_CREATE: definePermission(
    'digitalbank.account-statement.create',
    'Create statement.',
  ),
  ACCOUNT_STATEMENT_UPDATE: definePermission(
    'digitalbank.account-statement.update',
    'Modify statement.',
  ),
  CUSTOMER_NOTIFICATION_PREFERENCE_READ: definePermission(
    'digitalbank.customer-notification-preference.read',
    'View notification preferences.',
  ),
  CUSTOMER_NOTIFICATION_PREFERENCE_CREATE: definePermission(
    'digitalbank.customer-notification-preference.create',
    'Create preference.',
  ),
  CUSTOMER_NOTIFICATION_PREFERENCE_UPDATE: definePermission(
    'digitalbank.customer-notification-preference.update',
    'Modify preference.',
  ),
} as const;

export const DIGITAL_BANK_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(DIGITAL_BANK_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  DIGITAL_BANK_PERMISSIONS.BANK_CUSTOMER_READ.key,
  DIGITAL_BANK_PERMISSIONS.BANK_ACCOUNT_READ.key,
  DIGITAL_BANK_PERMISSIONS.ACCOUNT_STATEMENT_READ.key,
  DIGITAL_BANK_PERMISSIONS.CUSTOMER_NOTIFICATION_PREFERENCE_READ.key,
];

const WRITE = [
  DIGITAL_BANK_PERMISSIONS.BANK_CUSTOMER_CREATE.key,
  DIGITAL_BANK_PERMISSIONS.BANK_CUSTOMER_UPDATE.key,
  DIGITAL_BANK_PERMISSIONS.BANK_ACCOUNT_CREATE.key,
  DIGITAL_BANK_PERMISSIONS.BANK_ACCOUNT_UPDATE.key,
  DIGITAL_BANK_PERMISSIONS.ACCOUNT_STATEMENT_CREATE.key,
  DIGITAL_BANK_PERMISSIONS.ACCOUNT_STATEMENT_UPDATE.key,
  DIGITAL_BANK_PERMISSIONS.CUSTOMER_NOTIFICATION_PREFERENCE_CREATE.key,
  DIGITAL_BANK_PERMISSIONS.CUSTOMER_NOTIFICATION_PREFERENCE_UPDATE.key,
];

export const DIGITAL_BANK_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: DIGITAL_BANK_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type CustomerSegment = 'RETAIL' | 'SME' | 'CORPORATE';
export const CUSTOMER_SEGMENT_VALUES: CustomerSegment[] = ['RETAIL', 'SME', 'CORPORATE'];

export type BankCustomerStatus = 'PENDING' | 'ACTIVE' | 'DORMANT' | 'CLOSED';
export const BANK_CUSTOMER_STATUS_VALUES: BankCustomerStatus[] = [
  'PENDING',
  'ACTIVE',
  'DORMANT',
  'CLOSED',
];

export type BankAccountStatus = 'ACTIVE' | 'FROZEN' | 'DORMANT' | 'CLOSED';
export const BANK_ACCOUNT_STATUS_VALUES: BankAccountStatus[] = [
  'ACTIVE',
  'FROZEN',
  'DORMANT',
  'CLOSED',
];

export type StatementStatus = 'GENERATED' | 'DELIVERED' | 'FAILED';
export const STATEMENT_STATUS_VALUES: StatementStatus[] = ['GENERATED', 'DELIVERED', 'FAILED'];

export type NotificationChannelName = 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH';
export const NOTIFICATION_CHANNEL_NAME_VALUES: NotificationChannelName[] = [
  'IN_APP',
  'EMAIL',
  'SMS',
  'PUSH',
];
