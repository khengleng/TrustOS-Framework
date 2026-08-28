/**
 * Product domain — TrustOS Digital Bank.
 *
 * This template extends wallet, so its catalog is the union of every layer's. Each layer keeps
 * its own file and this one only joins them — which is why adding a permission to a parent
 * reaches every child without anybody editing the child.
 */

import type { PermissionDefinition } from '@trustos/template-sdk';
import { WALLET_PERMISSIONS_LIST, WALLET_PERMISSIONS_ROLES } from './wallet';
import { DIGITAL_BANK_PERMISSIONS_LIST, DIGITAL_BANK_PERMISSIONS_ROLES } from './digital-bank';

export * from './wallet';
export * from './digital-bank';

/** Every permission this application defines, seeded alongside the framework’s. */
export const PRODUCT_PERMISSIONS: PermissionDefinition[] = [
  ...WALLET_PERMISSIONS_LIST,
  ...DIGITAL_BANK_PERMISSIONS_LIST,
];

/**
 * Role-to-permission mapping, applied by the seed.
 *
 * Merged per role rather than per layer, so a role defined by two layers ends up with both sets
 * rather than whichever one was spread last.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = mergeRoles([
  WALLET_PERMISSIONS_ROLES,
  DIGITAL_BANK_PERMISSIONS_ROLES,
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
