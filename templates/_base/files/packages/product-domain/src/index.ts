/**
 * Product domain — default, empty catalog.
 *
 * Every template overrides this file with its own permissions and domain types.
 * It exists so the base layer is self-consistent: a template that forgets to
 * ship one still generates a project that compiles and seeds, rather than
 * failing with a missing-module error three steps later.
 *
 * If you are reading this in a generated project, the template you used did not
 * define a product catalog — add your permission keys here.
 */

export interface ProductPermission {
  key: string;
  resource: string;
  action: string;
  description: string;
}

/**
 * Permission keys this product defines, seeded alongside the framework's.
 *
 * Namespace them (`invoice.read`, not `read`) so they can never collide with a
 * framework key, and treat them as permanent: add keys freely, never rename
 * one. A renamed key silently grants or revokes access on every deployment that
 * has not been migrated.
 */
export const PRODUCT_PERMISSIONS: ProductPermission[] = [];

/**
 * Which framework roles receive which product permissions, applied by the seed.
 *
 * Keep `auditor` read-only, and keep `operator` narrower than
 * `administrator` — the framework's least-privilege defaults are only as good
 * as what a product adds on top.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = {
  organization_owner: [],
  administrator: [],
  operator: [],
  auditor: [],
};
