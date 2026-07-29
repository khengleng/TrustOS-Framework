import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustos/errors';
import type { ActorContext } from '@trustos/shared-types';
import { ROUTE_METADATA } from './metadata';
import { assertPermissions, assertRole, type PermissionMode } from '../permission-checker';

/**
 * Deny-by-default authorization guard.
 *
 * Register it globally, after the authentication guard. The ordering of checks
 * matters:
 *
 *   1. `@Public()`                  -> allowed, no actor needed
 *   2. no actor                     -> 401
 *   3. `@RequirePermissions(...)`   -> evaluated
 *   4. `@RequireRoles(...)`         -> evaluated
 *   5. `@AllowAnyAuthenticated()`   -> allowed
 *   6. nothing declared             -> 403
 *
 * Step 6 is the important one. A route that forgets its decorator fails
 * closed, so the mistake shows up the first time anyone calls the endpoint
 * rather than the first time it is abused.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.PUBLIC, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ actor?: ActorContext | null }>();
    const actor = request?.actor ?? null;
    if (!actor) throw ApiError.unauthorized();

    const permissions = this.reflector.getAllAndOverride<string[]>(
      ROUTE_METADATA.PERMISSIONS,
      targets,
    );
    if (permissions?.length) {
      const mode =
        this.reflector.getAllAndOverride<PermissionMode>(
          ROUTE_METADATA.PERMISSIONS_MODE,
          targets,
        ) ?? 'all';
      assertPermissions(actor, permissions, { mode });
      return true;
    }

    const roles = this.reflector.getAllAndOverride<string[]>(ROUTE_METADATA.ROLES, targets);
    if (roles?.length) {
      if (actor.isSuperAdmin) return true;
      const held = roles.find((role) => actor.roles.includes(role));
      if (!held) assertRole(actor, roles[0] as string);
      return true;
    }

    if (this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.ALLOW_AUTHENTICATED, targets)) {
      return true;
    }

    throw ApiError.forbidden(undefined, {
      reason: 'route_declares_no_access_policy',
      hint: 'Add @RequirePermissions(...), @RequireRoles(...), @AllowAnyAuthenticated() or @Public().',
      handler: context.getHandler().name,
      controller: context.getClass().name,
    });
  }
}
