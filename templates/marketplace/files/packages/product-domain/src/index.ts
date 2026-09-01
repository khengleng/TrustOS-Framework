/**
 * Product domain — TrustOS Marketplace.
 *
 * This template extends merchant -> ecommerce, so its catalog is the union of every layer's.
 * Each layer keeps its own file and this one only joins them — which is why adding a permission
 * to a parent reaches every child without anybody editing the child.
 */

import type { PermissionDefinition } from '@trustsystem/template-sdk';
import { MERCHANT_PERMISSIONS_LIST, MERCHANT_PERMISSIONS_ROLES } from './merchant';
import { ECOMMERCE_PERMISSIONS_LIST, ECOMMERCE_PERMISSIONS_ROLES } from './ecommerce';
import { MARKETPLACE_PERMISSIONS_LIST, MARKETPLACE_PERMISSIONS_ROLES } from './marketplace';

export * from './merchant';
export * from './ecommerce';
export * from './marketplace';

/** Every permission this application defines, seeded alongside the framework’s. */
export const PRODUCT_PERMISSIONS: PermissionDefinition[] = [
  ...MERCHANT_PERMISSIONS_LIST,
  ...ECOMMERCE_PERMISSIONS_LIST,
  ...MARKETPLACE_PERMISSIONS_LIST,
];

/**
 * Role-to-permission mapping, applied by the seed.
 *
 * Merged per role rather than per layer, so a role defined by two layers ends up with both sets
 * rather than whichever one was spread last.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = mergeRoles([
  MERCHANT_PERMISSIONS_ROLES,
  ECOMMERCE_PERMISSIONS_ROLES,
  MARKETPLACE_PERMISSIONS_ROLES,
]);

function mergeRoles(layers: Array<Record<string, string[]>>): Record<string, string[]> {
  const merged: Record<string, string[]> = {};

  for (const layer of layers) {
    for (const [role, permissions] of Object.entries(layer)) {
      merged[role] = [...new Set([...(merged[role] ?? []), ...permissions])];
    }
  }

  return merged;
}
