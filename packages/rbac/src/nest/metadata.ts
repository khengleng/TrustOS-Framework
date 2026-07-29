/**
 * Route metadata keys.
 *
 * Centralized so the guards in @trustos/rbac and the decorators in
 * @trustos/auth agree on the strings without either package guessing.
 */
export const ROUTE_METADATA = {
  /** Route requires no authentication at all. Set by `@Public()`. */
  PUBLIC: 'trustos:public',
  /** Route requires authentication but no specific permission. */
  ALLOW_AUTHENTICATED: 'trustos:allow-authenticated',
  PERMISSIONS: 'trustos:permissions',
  PERMISSIONS_MODE: 'trustos:permissions-mode',
  ROLES: 'trustos:roles',
} as const;
