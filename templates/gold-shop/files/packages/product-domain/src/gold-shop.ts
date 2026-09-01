/**
 * TrustOS Gold Shop — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const GOLD_SHOP_PERMISSIONS = {
  GOLD_PRICE_READ: definePermission('goldshop.gold-price.read', 'View price quotes.'),
  GOLD_PRICE_CREATE: definePermission('goldshop.gold-price.create', 'Create price quote.'),
  GOLD_PRICE_UPDATE: definePermission('goldshop.gold-price.update', 'Modify price quote.'),
  GOLD_ITEM_READ: definePermission('goldshop.gold-item.read', 'View inventory.'),
  GOLD_ITEM_CREATE: definePermission('goldshop.gold-item.create', 'Create item.'),
  GOLD_ITEM_UPDATE: definePermission('goldshop.gold-item.update', 'Modify item.'),
  GOLD_ORDER_READ: definePermission('goldshop.gold-order.read', 'View orders.'),
  GOLD_ORDER_CREATE: definePermission('goldshop.gold-order.create', 'Create order.'),
  GOLD_ORDER_UPDATE: definePermission('goldshop.gold-order.update', 'Modify order.'),
  GOLD_INVOICE_READ: definePermission('goldshop.gold-invoice.read', 'View invoices.'),
  GOLD_INVOICE_CREATE: definePermission('goldshop.gold-invoice.create', 'Create invoice.'),
  GOLD_INVOICE_UPDATE: definePermission('goldshop.gold-invoice.update', 'Modify invoice.'),
} as const;

export const GOLD_SHOP_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(GOLD_SHOP_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  GOLD_SHOP_PERMISSIONS.GOLD_PRICE_READ.key,
  GOLD_SHOP_PERMISSIONS.GOLD_ITEM_READ.key,
  GOLD_SHOP_PERMISSIONS.GOLD_ORDER_READ.key,
  GOLD_SHOP_PERMISSIONS.GOLD_INVOICE_READ.key,
];

const WRITE = [
  GOLD_SHOP_PERMISSIONS.GOLD_PRICE_CREATE.key,
  GOLD_SHOP_PERMISSIONS.GOLD_PRICE_UPDATE.key,
  GOLD_SHOP_PERMISSIONS.GOLD_ITEM_CREATE.key,
  GOLD_SHOP_PERMISSIONS.GOLD_ITEM_UPDATE.key,
  GOLD_SHOP_PERMISSIONS.GOLD_ORDER_CREATE.key,
  GOLD_SHOP_PERMISSIONS.GOLD_ORDER_UPDATE.key,
  GOLD_SHOP_PERMISSIONS.GOLD_INVOICE_CREATE.key,
  GOLD_SHOP_PERMISSIONS.GOLD_INVOICE_UPDATE.key,
];

export const GOLD_SHOP_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: GOLD_SHOP_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type GoldKarat = 'K10' | 'K14' | 'K18' | 'K21' | 'K22' | 'K24';
export const GOLD_KARAT_VALUES: GoldKarat[] = ['K10', 'K14', 'K18', 'K21', 'K22', 'K24'];

export type GoldItemStatus = 'IN_STOCK' | 'RESERVED' | 'SOLD' | 'MELTED';
export const GOLD_ITEM_STATUS_VALUES: GoldItemStatus[] = ['IN_STOCK', 'RESERVED', 'SOLD', 'MELTED'];

export type GoldOrderDirection = 'SELL_TO_CUSTOMER' | 'BUY_FROM_CUSTOMER';
export const GOLD_ORDER_DIRECTION_VALUES: GoldOrderDirection[] = [
  'SELL_TO_CUSTOMER',
  'BUY_FROM_CUSTOMER',
];

export type GoldOrderStatus = 'DRAFT' | 'CONFIRMED' | 'SETTLED' | 'CANCELLED';
export const GOLD_ORDER_STATUS_VALUES: GoldOrderStatus[] = [
  'DRAFT',
  'CONFIRMED',
  'SETTLED',
  'CANCELLED',
];

export type GoldInvoiceStatus = 'ISSUED' | 'PAID' | 'VOID';
export const GOLD_INVOICE_STATUS_VALUES: GoldInvoiceStatus[] = ['ISSUED', 'PAID', 'VOID'];
