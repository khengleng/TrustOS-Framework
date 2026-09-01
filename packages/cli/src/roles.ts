/**
 * Roles offered when creating a new application.
 *
 * These mirror the framework's system roles rather than redefining them: the
 * generated seed attaches the framework catalog, and a product adds its own
 * roles later. Listing them here is a prompt convenience, not a second source
 * of truth — @trustsystem/rbac remains authoritative.
 */
export const SYSTEM_ROLE_SUGGESTIONS = [
  'organization_owner',
  'administrator',
  'operator',
  'auditor',
] as const;
