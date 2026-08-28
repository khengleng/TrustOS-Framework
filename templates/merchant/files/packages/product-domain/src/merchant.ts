/**
 * Product domain — TrustOS Merchant.
 *
 * Permission keys are namespaced so they can never collide with a framework
 * key, and they are part of the public contract: add keys freely, never rename
 * one. A renamed key silently grants or revokes access on every deployment that
 * has not been migrated.
 */

export interface ProductPermission {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): ProductPermission {
  const segments = key.split('.');
  return {
    key,
    resource: segments.slice(0, -1).join('.'),
    action: segments[segments.length - 1] as string,
    description,
  };
}

export const MERCHANT_PERMISSIONS = {
  MERCHANT_READ: define('merchant.read', 'View merchants.'),
  MERCHANT_CREATE: define('merchant.create', 'Register a merchant.'),
  MERCHANT_UPDATE: define('merchant.update', 'Modify a merchant.'),

  STORE_READ: define('merchant.store.read', 'View stores.'),
  STORE_CREATE: define('merchant.store.create', 'Create a store.'),
  STORE_UPDATE: define('merchant.store.update', 'Modify a store.'),

  BRANCH_READ: define('merchant.branch.read', 'View branches.'),
  BRANCH_CREATE: define('merchant.branch.create', 'Create a branch.'),
  BRANCH_UPDATE: define('merchant.branch.update', 'Modify a branch.'),

  MEMBER_READ: define('merchant.member.read', 'View merchant members.'),
  MEMBER_MANAGE: define('merchant.member.manage', 'Add or remove merchant members.'),
} as const;

/**
 * This layer's permissions, as a list.
 *
 * Named for the layer rather than for the product because a template extending this one composes
 * several of these in `index.ts`. Two layers both exporting `PRODUCT_PERMISSIONS` could not be
 * imported into the same file.
 */
export const MERCHANT_PERMISSIONS_LIST: ProductPermission[] = Object.values(MERCHANT_PERMISSIONS);

const READ_ONLY = [
  MERCHANT_PERMISSIONS.MERCHANT_READ.key,
  MERCHANT_PERMISSIONS.STORE_READ.key,
  MERCHANT_PERMISSIONS.BRANCH_READ.key,
  MERCHANT_PERMISSIONS.MEMBER_READ.key,
];

/**
 * Which framework roles receive which product permissions, applied by the seed.
 *
 * Least privilege: `operator` runs day-to-day store work but cannot register a
 * merchant or change who its members are; `auditor` is read-only by definition
 * and must never gain a write permission here.
 */
export const MERCHANT_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: MERCHANT_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [
    ...READ_ONLY,
    MERCHANT_PERMISSIONS.MERCHANT_CREATE.key,
    MERCHANT_PERMISSIONS.MERCHANT_UPDATE.key,
    MERCHANT_PERMISSIONS.STORE_CREATE.key,
    MERCHANT_PERMISSIONS.STORE_UPDATE.key,
    MERCHANT_PERMISSIONS.BRANCH_CREATE.key,
    MERCHANT_PERMISSIONS.BRANCH_UPDATE.key,
    MERCHANT_PERMISSIONS.MEMBER_MANAGE.key,
  ],
  operator: [...READ_ONLY, MERCHANT_PERMISSIONS.BRANCH_UPDATE.key],
  auditor: READ_ONLY,
};

export type MerchantStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';
export type StoreStatus = 'ACTIVE' | 'CLOSED';

export const MERCHANT_STATUSES: MerchantStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED'];
export const STORE_STATUSES: StoreStatus[] = ['ACTIVE', 'CLOSED'];
