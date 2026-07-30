/**
 * TrustOS Insurance — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const INSURANCE_PERMISSIONS = {
  POLICY_HOLDER_READ: definePermission('insurance.policy-holder.read', 'View policyholders.'),
  POLICY_HOLDER_CREATE: definePermission('insurance.policy-holder.create', 'Create policyholder.'),
  POLICY_HOLDER_UPDATE: definePermission('insurance.policy-holder.update', 'Modify policyholder.'),
  INSURANCE_PRODUCT_READ: definePermission('insurance.insurance-product.read', 'View products.'),
  INSURANCE_PRODUCT_CREATE: definePermission(
    'insurance.insurance-product.create',
    'Create product.',
  ),
  INSURANCE_PRODUCT_UPDATE: definePermission(
    'insurance.insurance-product.update',
    'Modify product.',
  ),
  POLICY_READ: definePermission('insurance.policy.read', 'View policies.'),
  POLICY_CREATE: definePermission('insurance.policy.create', 'Create policy.'),
  POLICY_UPDATE: definePermission('insurance.policy.update', 'Modify policy.'),
  PREMIUM_READ: definePermission('insurance.premium.read', 'View premiums.'),
  PREMIUM_CREATE: definePermission('insurance.premium.create', 'Create premium.'),
  PREMIUM_UPDATE: definePermission('insurance.premium.update', 'Modify premium.'),
  CLAIM_READ: definePermission('insurance.claim.read', 'View claims.'),
  CLAIM_CREATE: definePermission('insurance.claim.create', 'Create claim.'),
  CLAIM_UPDATE: definePermission('insurance.claim.update', 'Modify claim.'),
} as const;

export const INSURANCE_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(INSURANCE_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  INSURANCE_PERMISSIONS.POLICY_HOLDER_READ.key,
  INSURANCE_PERMISSIONS.INSURANCE_PRODUCT_READ.key,
  INSURANCE_PERMISSIONS.POLICY_READ.key,
  INSURANCE_PERMISSIONS.PREMIUM_READ.key,
  INSURANCE_PERMISSIONS.CLAIM_READ.key,
];

const WRITE = [
  INSURANCE_PERMISSIONS.POLICY_HOLDER_CREATE.key,
  INSURANCE_PERMISSIONS.POLICY_HOLDER_UPDATE.key,
  INSURANCE_PERMISSIONS.INSURANCE_PRODUCT_CREATE.key,
  INSURANCE_PERMISSIONS.INSURANCE_PRODUCT_UPDATE.key,
  INSURANCE_PERMISSIONS.POLICY_CREATE.key,
  INSURANCE_PERMISSIONS.POLICY_UPDATE.key,
  INSURANCE_PERMISSIONS.PREMIUM_CREATE.key,
  INSURANCE_PERMISSIONS.PREMIUM_UPDATE.key,
  INSURANCE_PERMISSIONS.CLAIM_CREATE.key,
  INSURANCE_PERMISSIONS.CLAIM_UPDATE.key,
];

export const INSURANCE_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: INSURANCE_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type InsuranceCategory = 'LIFE' | 'HEALTH' | 'MOTOR' | 'PROPERTY' | 'TRAVEL';
export const INSURANCE_CATEGORY_VALUES: InsuranceCategory[] = [
  'LIFE',
  'HEALTH',
  'MOTOR',
  'PROPERTY',
  'TRAVEL',
];

export type PolicyStatus = 'QUOTED' | 'ACTIVE' | 'LAPSED' | 'CANCELLED' | 'EXPIRED';
export const POLICY_STATUS_VALUES: PolicyStatus[] = [
  'QUOTED',
  'ACTIVE',
  'LAPSED',
  'CANCELLED',
  'EXPIRED',
];

export type PremiumStatus = 'DUE' | 'PAID' | 'OVERDUE' | 'WAIVED';
export const PREMIUM_STATUS_VALUES: PremiumStatus[] = ['DUE', 'PAID', 'OVERDUE', 'WAIVED'];

export type ClaimStatus = 'REPORTED' | 'ASSESSING' | 'APPROVED' | 'REJECTED' | 'PAID' | 'WITHDRAWN';
export const CLAIM_STATUS_VALUES: ClaimStatus[] = [
  'REPORTED',
  'ASSESSING',
  'APPROVED',
  'REJECTED',
  'PAID',
  'WITHDRAWN',
];
