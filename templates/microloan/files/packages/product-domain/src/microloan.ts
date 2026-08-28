/**
 * TrustOS Microloan — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const MICROLOAN_PERMISSIONS = {
  BORROWER_READ: definePermission('microloan.borrower.read', 'View borrowers.'),
  BORROWER_CREATE: definePermission('microloan.borrower.create', 'Create borrower.'),
  BORROWER_UPDATE: definePermission('microloan.borrower.update', 'Modify borrower.'),
  LOAN_PRODUCT_READ: definePermission('microloan.loan-product.read', 'View loan products.'),
  LOAN_PRODUCT_CREATE: definePermission('microloan.loan-product.create', 'Create loan product.'),
  LOAN_PRODUCT_UPDATE: definePermission('microloan.loan-product.update', 'Modify loan product.'),
  LOAN_APPLICATION_READ: definePermission('microloan.loan-application.read', 'View applications.'),
  LOAN_APPLICATION_CREATE: definePermission(
    'microloan.loan-application.create',
    'Create application.',
  ),
  LOAN_APPLICATION_UPDATE: definePermission(
    'microloan.loan-application.update',
    'Modify application.',
  ),
  LOAN_ACCOUNT_READ: definePermission('microloan.loan-account.read', 'View loans.'),
  LOAN_ACCOUNT_CREATE: definePermission('microloan.loan-account.create', 'Create loan.'),
  LOAN_ACCOUNT_UPDATE: definePermission('microloan.loan-account.update', 'Modify loan.'),
  REPAYMENT_INSTALMENT_READ: definePermission(
    'microloan.repayment-instalment.read',
    'View instalments.',
  ),
  REPAYMENT_INSTALMENT_CREATE: definePermission(
    'microloan.repayment-instalment.create',
    'Create instalment.',
  ),
  REPAYMENT_INSTALMENT_UPDATE: definePermission(
    'microloan.repayment-instalment.update',
    'Modify instalment.',
  ),
  REPAYMENT_READ: definePermission('microloan.repayment.read', 'View repayments.'),
  REPAYMENT_CREATE: definePermission('microloan.repayment.create', 'Create repayment.'),
  REPAYMENT_UPDATE: definePermission('microloan.repayment.update', 'Modify repayment.'),
} as const;

export const MICROLOAN_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(MICROLOAN_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  MICROLOAN_PERMISSIONS.BORROWER_READ.key,
  MICROLOAN_PERMISSIONS.LOAN_PRODUCT_READ.key,
  MICROLOAN_PERMISSIONS.LOAN_APPLICATION_READ.key,
  MICROLOAN_PERMISSIONS.LOAN_ACCOUNT_READ.key,
  MICROLOAN_PERMISSIONS.REPAYMENT_INSTALMENT_READ.key,
  MICROLOAN_PERMISSIONS.REPAYMENT_READ.key,
];

const WRITE = [
  MICROLOAN_PERMISSIONS.BORROWER_CREATE.key,
  MICROLOAN_PERMISSIONS.BORROWER_UPDATE.key,
  MICROLOAN_PERMISSIONS.LOAN_PRODUCT_CREATE.key,
  MICROLOAN_PERMISSIONS.LOAN_PRODUCT_UPDATE.key,
  MICROLOAN_PERMISSIONS.LOAN_APPLICATION_CREATE.key,
  MICROLOAN_PERMISSIONS.LOAN_APPLICATION_UPDATE.key,
  MICROLOAN_PERMISSIONS.LOAN_ACCOUNT_CREATE.key,
  MICROLOAN_PERMISSIONS.LOAN_ACCOUNT_UPDATE.key,
  MICROLOAN_PERMISSIONS.REPAYMENT_INSTALMENT_CREATE.key,
  MICROLOAN_PERMISSIONS.REPAYMENT_INSTALMENT_UPDATE.key,
  MICROLOAN_PERMISSIONS.REPAYMENT_CREATE.key,
  MICROLOAN_PERMISSIONS.REPAYMENT_UPDATE.key,
];

export const MICROLOAN_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: MICROLOAN_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type BorrowerStatus = 'ACTIVE' | 'BLOCKED' | 'CLOSED';
export const BORROWER_STATUS_VALUES: BorrowerStatus[] = ['ACTIVE', 'BLOCKED', 'CLOSED'];

export type ApplicationStatus =
  'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
export const APPLICATION_STATUS_VALUES: ApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
];

export type LoanStatus = 'ACTIVE' | 'IN_ARREARS' | 'CLOSED' | 'WRITTEN_OFF' | 'RESTRUCTURED';
export const LOAN_STATUS_VALUES: LoanStatus[] = [
  'ACTIVE',
  'IN_ARREARS',
  'CLOSED',
  'WRITTEN_OFF',
  'RESTRUCTURED',
];

export type InstalmentStatus = 'DUE' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'WAIVED';
export const INSTALMENT_STATUS_VALUES: InstalmentStatus[] = [
  'DUE',
  'PAID',
  'PARTIAL',
  'OVERDUE',
  'WAIVED',
];

export type RepaymentMethod = 'CASH' | 'WALLET' | 'BANK_TRANSFER' | 'ADJUSTMENT';
export const REPAYMENT_METHOD_VALUES: RepaymentMethod[] = [
  'CASH',
  'WALLET',
  'BANK_TRANSFER',
  'ADJUSTMENT',
];
