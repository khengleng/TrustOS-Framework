/**
 * Product domain — TrustOS Education.
 *
 * One layer today. If a template comes to extend this one, it will re-export this file alongside
 * its own rather than copying anything out of it.
 */

import type { PermissionDefinition } from '@trustsystem/template-sdk';
import { EDUCATION_PERMISSIONS_LIST, EDUCATION_PERMISSIONS_ROLES } from './education';

export * from './education';

/** Every permission this application defines, seeded alongside the framework’s. */
export const PRODUCT_PERMISSIONS: PermissionDefinition[] = [...EDUCATION_PERMISSIONS_LIST];

/**
 * Role-to-permission mapping, applied by the seed.
 *
 * Merged per role rather than per layer, so a role defined by two layers ends up with both sets
 * rather than whichever one was spread last.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = mergeRoles([
  EDUCATION_PERMISSIONS_ROLES,
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
