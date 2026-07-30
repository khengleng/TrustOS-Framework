/**
 * The permission check every SDK primitive takes.
 *
 * A function rather than a `string[]`, so the caller decides where the answer comes from — a
 * loaded role in the admin, the framework `Authorizer` in the API, a fixture in a test — and the
 * SDK never has an opinion about how permissions are stored.
 *
 * Synchronous on purpose. An async check inside a menu render is a waterfall of one request per
 * item, and the honest fix is to load the actor's permissions once at the edge, which every
 * TrustOS application already does.
 */
export type PermissionCheck = (permission: string) => boolean;

/** Grants everything. For tests and for a single-tenant tool with no RBAC. */
export const allowAll: PermissionCheck = () => true;

/** Grants nothing. The correct default for an unauthenticated actor. */
export const denyAll: PermissionCheck = () => false;

/**
 * A check backed by a set of granted keys.
 *
 * Exact matching only — no wildcards. `merchant.*` looks convenient and means a permission added
 * next year is granted retroactively to everyone who has the wildcard today, which is how a
 * read-only role silently acquires a write.
 */
export function permissionsFrom(granted: Iterable<string>): PermissionCheck {
  const set = new Set(granted);
  return (permission) => set.has(permission);
}

/**
 * A permission key a template declares.
 *
 * The same shape templates already export as `PRODUCT_PERMISSIONS`, lifted into the SDK so the
 * navigation, the tables and the CRUD contract can all read one definition.
 */
export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
}

/**
 * Builds a permission definition from a dotted key.
 *
 * Keys are a public contract: add freely, never rename. A renamed key silently revokes access on
 * every deployment that has not been migrated and grants it on none — the failure is invisible
 * until somebody cannot do their job.
 */
export function definePermission(key: string, description: string): PermissionDefinition {
  const segments = key.split('.');
  const action = segments[segments.length - 1];

  if (segments.length < 2 || !action) {
    throw new Error(
      `Permission key "${key}" must be at least "resource.action" — a bare action cannot be ` +
        'namespaced, and an un-namespaced key collides with the framework the moment a template ' +
        'and a package pick the same word.',
    );
  }

  return { key, resource: segments.slice(0, -1).join('.'), action, description };
}

/** The four CRUD actions, as a template usually declares them for one resource. */
export function defineCrudPermissions(
  resource: string,
  label: string,
): Record<'read' | 'create' | 'update' | 'delete', PermissionDefinition> {
  return {
    read: definePermission(`${resource}.read`, `View ${label}.`),
    create: definePermission(`${resource}.create`, `Create ${label}.`),
    update: definePermission(`${resource}.update`, `Modify ${label}.`),
    delete: definePermission(`${resource}.delete`, `Remove ${label}.`),
  };
}
