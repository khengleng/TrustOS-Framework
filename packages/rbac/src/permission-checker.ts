import { ApiError } from '@trustsystem/errors';
import type { ActorContext } from '@trustsystem/shared-types';
import { WILDCARD_PERMISSION } from './permissions';

/**
 * Server-side permission evaluation.
 *
 * This is the only place a permission decision is made. The admin app hides
 * buttons the user cannot use, but that is a courtesy, not a control — every
 * mutation is re-checked here.
 */

export type PermissionMode = 'all' | 'any';

export interface PermissionCheckOptions {
  /** 'all' (default) requires every listed permission; 'any' requires one. */
  mode?: PermissionMode;
}

/**
 * Matches a held permission against a required one.
 *
 * Supports two wildcard forms:
 *   `*`                  — everything (super_admin only)
 *   `organization.*`     — every action under a resource prefix
 */
export function permissionMatches(held: string, required: string): boolean {
  if (held === WILDCARD_PERMISSION) return true;
  if (held === required) return true;
  if (held.endsWith('.*')) {
    const prefix = held.slice(0, -1); // keep the trailing dot
    return required.startsWith(prefix);
  }
  return false;
}

export function hasPermission(actor: ActorContext | null, required: string): boolean {
  if (!actor) return false;
  if (actor.isSuperAdmin) return true;
  return actor.permissions.some((held) => permissionMatches(held, required));
}

export function hasPermissions(
  actor: ActorContext | null,
  required: string[],
  options: PermissionCheckOptions = {},
): boolean {
  if (!actor) return false;
  if (required.length === 0) {
    // An empty requirement is almost always a bug in the caller (a decorator
    // invoked with a spread that resolved to nothing). Deny rather than allow.
    return false;
  }
  const mode = options.mode ?? 'all';
  return mode === 'any'
    ? required.some((permission) => hasPermission(actor, permission))
    : required.every((permission) => hasPermission(actor, permission));
}

/**
 * Throws `forbidden` unless the actor holds the required permissions.
 *
 * The thrown error carries the missing permissions in `context` — visible to
 * operators in logs, never in the response body, because telling a caller
 * exactly which permission they lack maps out the authorization model.
 */
export function assertPermissions(
  actor: ActorContext | null,
  required: string[],
  options: PermissionCheckOptions = {},
): void {
  if (!actor) {
    throw ApiError.unauthorized();
  }
  if (hasPermissions(actor, required, options)) return;

  throw ApiError.forbidden(undefined, {
    requiredPermissions: required,
    mode: options.mode ?? 'all',
    actorId: actor.userId,
    organizationId: actor.organizationId,
    heldPermissions: actor.permissions,
  });
}

/** Convenience wrapper for a single permission. */
export function assertPermission(actor: ActorContext | null, required: string): void {
  assertPermissions(actor, [required]);
}

export function hasRole(actor: ActorContext | null, roleName: string): boolean {
  return Boolean(actor?.roles.includes(roleName));
}

export function assertRole(actor: ActorContext | null, roleName: string): void {
  if (!actor) throw ApiError.unauthorized();
  if (actor.isSuperAdmin || hasRole(actor, roleName)) return;
  throw ApiError.forbidden(undefined, {
    requiredRole: roleName,
    actorId: actor.userId,
    heldRoles: actor.roles,
  });
}

/**
 * Flattens role definitions into an effective permission set.
 *
 * Called once per request during authentication so every later check is a set
 * lookup rather than a database round trip.
 */
export function resolvePermissions(
  roles: Array<{ name: string; permissions: string[] }>,
): string[] {
  const effective = new Set<string>();
  for (const role of roles) {
    for (const permission of role.permissions) effective.add(permission);
  }
  return [...effective].sort();
}
