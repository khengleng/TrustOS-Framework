/**
 * TrustOS Marketplace — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const MARKETPLACE_PERMISSIONS = {
  SELLER_READ: definePermission('marketplace.seller.read', 'View sellers.'),
  SELLER_CREATE: definePermission('marketplace.seller.create', 'Create seller.'),
  SELLER_UPDATE: definePermission('marketplace.seller.update', 'Modify seller.'),
  LISTING_READ: definePermission('marketplace.listing.read', 'View listings.'),
  LISTING_CREATE: definePermission('marketplace.listing.create', 'Create listing.'),
  LISTING_UPDATE: definePermission('marketplace.listing.update', 'Modify listing.'),
  SELLER_PAYOUT_READ: definePermission('marketplace.seller-payout.read', 'View payouts.'),
  SELLER_PAYOUT_CREATE: definePermission('marketplace.seller-payout.create', 'Create payout.'),
  SELLER_PAYOUT_UPDATE: definePermission('marketplace.seller-payout.update', 'Modify payout.'),
  DISPUTE_READ: definePermission('marketplace.dispute.read', 'View disputes.'),
  DISPUTE_CREATE: definePermission('marketplace.dispute.create', 'Create dispute.'),
  DISPUTE_UPDATE: definePermission('marketplace.dispute.update', 'Modify dispute.'),
} as const;

export const MARKETPLACE_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(MARKETPLACE_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  MARKETPLACE_PERMISSIONS.SELLER_READ.key,
  MARKETPLACE_PERMISSIONS.LISTING_READ.key,
  MARKETPLACE_PERMISSIONS.SELLER_PAYOUT_READ.key,
  MARKETPLACE_PERMISSIONS.DISPUTE_READ.key,
];

const WRITE = [
  MARKETPLACE_PERMISSIONS.SELLER_CREATE.key,
  MARKETPLACE_PERMISSIONS.SELLER_UPDATE.key,
  MARKETPLACE_PERMISSIONS.LISTING_CREATE.key,
  MARKETPLACE_PERMISSIONS.LISTING_UPDATE.key,
  MARKETPLACE_PERMISSIONS.SELLER_PAYOUT_CREATE.key,
  MARKETPLACE_PERMISSIONS.SELLER_PAYOUT_UPDATE.key,
  MARKETPLACE_PERMISSIONS.DISPUTE_CREATE.key,
  MARKETPLACE_PERMISSIONS.DISPUTE_UPDATE.key,
];

export const MARKETPLACE_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: MARKETPLACE_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type SellerStatus = 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export const SELLER_STATUS_VALUES: SellerStatus[] = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'CLOSED'];

export type PayoutStatus = 'DRAFT' | 'APPROVED' | 'PAID' | 'FAILED';
export const PAYOUT_STATUS_VALUES: PayoutStatus[] = ['DRAFT', 'APPROVED', 'PAID', 'FAILED'];

export type DisputeStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'REJECTED';
export const DISPUTE_STATUS_VALUES: DisputeStatus[] = [
  'OPEN',
  'INVESTIGATING',
  'RESOLVED',
  'REJECTED',
];
