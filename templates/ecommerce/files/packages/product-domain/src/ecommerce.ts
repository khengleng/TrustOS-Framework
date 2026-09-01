/**
 * TrustOS E-commerce — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const ECOMMERCE_PERMISSIONS = {
  CATALOG_READ: definePermission('ecommerce.catalog.read', 'View catalogs.'),
  CATALOG_CREATE: definePermission('ecommerce.catalog.create', 'Create catalog.'),
  CATALOG_UPDATE: definePermission('ecommerce.catalog.update', 'Modify catalog.'),
  PRODUCT_READ: definePermission('ecommerce.product.read', 'View products.'),
  PRODUCT_CREATE: definePermission('ecommerce.product.create', 'Create product.'),
  PRODUCT_UPDATE: definePermission('ecommerce.product.update', 'Modify product.'),
  PRODUCT_VARIANT_READ: definePermission('ecommerce.product-variant.read', 'View variants.'),
  PRODUCT_VARIANT_CREATE: definePermission('ecommerce.product-variant.create', 'Create variant.'),
  PRODUCT_VARIANT_UPDATE: definePermission('ecommerce.product-variant.update', 'Modify variant.'),
  ORDER_READ: definePermission('ecommerce.order.read', 'View orders.'),
  ORDER_CREATE: definePermission('ecommerce.order.create', 'Create order.'),
  ORDER_UPDATE: definePermission('ecommerce.order.update', 'Modify order.'),
  ORDER_LINE_READ: definePermission('ecommerce.order-line.read', 'View order lines.'),
  ORDER_LINE_CREATE: definePermission('ecommerce.order-line.create', 'Create order line.'),
  ORDER_LINE_UPDATE: definePermission('ecommerce.order-line.update', 'Modify order line.'),
} as const;

export const ECOMMERCE_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(ECOMMERCE_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  ECOMMERCE_PERMISSIONS.CATALOG_READ.key,
  ECOMMERCE_PERMISSIONS.PRODUCT_READ.key,
  ECOMMERCE_PERMISSIONS.PRODUCT_VARIANT_READ.key,
  ECOMMERCE_PERMISSIONS.ORDER_READ.key,
  ECOMMERCE_PERMISSIONS.ORDER_LINE_READ.key,
];

const WRITE = [
  ECOMMERCE_PERMISSIONS.CATALOG_CREATE.key,
  ECOMMERCE_PERMISSIONS.CATALOG_UPDATE.key,
  ECOMMERCE_PERMISSIONS.PRODUCT_CREATE.key,
  ECOMMERCE_PERMISSIONS.PRODUCT_UPDATE.key,
  ECOMMERCE_PERMISSIONS.PRODUCT_VARIANT_CREATE.key,
  ECOMMERCE_PERMISSIONS.PRODUCT_VARIANT_UPDATE.key,
  ECOMMERCE_PERMISSIONS.ORDER_CREATE.key,
  ECOMMERCE_PERMISSIONS.ORDER_UPDATE.key,
  ECOMMERCE_PERMISSIONS.ORDER_LINE_CREATE.key,
  ECOMMERCE_PERMISSIONS.ORDER_LINE_UPDATE.key,
];

export const ECOMMERCE_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: ECOMMERCE_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export const PRODUCT_STATUS_VALUES: ProductStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED' | 'REFUNDED';
export const ORDER_STATUS_VALUES: OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'FULFILLED',
  'CANCELLED',
  'REFUNDED',
];
