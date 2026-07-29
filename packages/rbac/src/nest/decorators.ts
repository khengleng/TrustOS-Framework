import { SetMetadata, applyDecorators, type CustomDecorator } from '@nestjs/common';
import { ROUTE_METADATA } from './metadata';
import type { PermissionMode } from '../permission-checker';

/**
 * Declares the permissions a route requires.
 *
 *   @RequirePermissions(PERMISSIONS.MEMBER_INVITE.key)
 *   @Post('members')
 *   invite() {}
 *
 * All listed permissions are required. Use `RequireAnyPermission` for an
 * either/or route.
 */
export function RequirePermissions(...permissions: string[]) {
  return applyDecorators(
    SetMetadata(ROUTE_METADATA.PERMISSIONS, permissions),
    SetMetadata(ROUTE_METADATA.PERMISSIONS_MODE, 'all' satisfies PermissionMode),
  );
}

/** Route is allowed if the actor holds *any* of the listed permissions. */
export function RequireAnyPermission(...permissions: string[]) {
  return applyDecorators(
    SetMetadata(ROUTE_METADATA.PERMISSIONS, permissions),
    SetMetadata(ROUTE_METADATA.PERMISSIONS_MODE, 'any' satisfies PermissionMode),
  );
}

/** Route requires one of the named roles. Prefer permissions where possible. */
export function RequireRoles(...roles: string[]): CustomDecorator<string> {
  return SetMetadata(ROUTE_METADATA.ROLES, roles);
}

/**
 * Route requires a valid session but no particular permission — e.g. `/me`.
 *
 * This has to be explicit because `PermissionsGuard` denies any authenticated
 * route that declares nothing. Forgetting a decorator should produce a 403 in
 * staging, not an unprotected endpoint in production.
 */
export function AllowAnyAuthenticated(): CustomDecorator<string> {
  return SetMetadata(ROUTE_METADATA.ALLOW_AUTHENTICATED, true);
}
