/**
 * Product domain — TrustOS School.
 *
 * This template extends education, so its catalog is the union of every layer's. Each layer
 * keeps its own file and this one only joins them — which is why adding a permission to a parent
 * reaches every child without anybody editing the child.
 */

import type { PermissionDefinition } from '@trustos/template-sdk';
import { EDUCATION_PERMISSIONS_LIST, EDUCATION_PERMISSIONS_ROLES } from './education';
import { SCHOOL_PERMISSIONS_LIST, SCHOOL_PERMISSIONS_ROLES } from './school';

export * from './education';
export * from './school';

/** Every permission this application defines, seeded alongside the framework’s. */
export const PRODUCT_PERMISSIONS: PermissionDefinition[] = [
  ...EDUCATION_PERMISSIONS_LIST,
  ...SCHOOL_PERMISSIONS_LIST,
];

/**
 * Role-to-permission mapping, applied by the seed.
 *
 * Merged per role rather than per layer, so a role defined by two layers ends up with both sets
 * rather than whichever one was spread last.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = mergeRoles([
  EDUCATION_PERMISSIONS_ROLES,
  SCHOOL_PERMISSIONS_ROLES,
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
