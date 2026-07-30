import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustos/errors';
import { ROUTE_METADATA } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import type { Authorizer } from '../authorizer';
import { AUTHORIZATION_METADATA } from './metadata';

/**
 * Runs the policy set for a route that declares an action.
 *
 * Registered after the permission guard, not instead of it. Two guards rather than
 * one because they fail differently and both failures are worth keeping: a route
 * with no `@RequirePermissions` is a route nobody protected, and a route that
 * passes RBAC but fails a policy is a legitimate permission used somewhere it must
 * not be.
 *
 * A route that declares no action is not evaluated here. It has already survived
 * the deny-by-default permission guard, so declaring an action is an *addition*
 * rather than the only protection — which is what makes adopting the policy layer
 * incremental instead of a rewrite.
 */
@Injectable()
export class PolicyAuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorizer: Authorizer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.PUBLIC, targets)) return true;

    const action = this.reflector.getAllAndOverride<string>(AUTHORIZATION_METADATA.ACTION, targets);
    if (!action) return true;

    const request = context.switchToHttp().getRequest<{
      actor?: ActorContext | null;
      organizationId?: string | null;
      requestId?: string;
      ip?: string;
    }>();

    const actor = request?.actor ?? null;
    if (!actor) throw ApiError.unauthorized();

    const resourceType = this.reflector.getAllAndOverride<string>(
      AUTHORIZATION_METADATA.RESOURCE_TYPE,
      targets,
    );

    await this.authorizer.assert({
      actor,
      action,
      // The organization the tenant guard resolved — never a header. See
      // `tenantMembershipPolicy` for the attack this closes.
      organizationId: request.organizationId ?? actor.organizationId ?? null,
      ...(resourceType ? { resource: { type: resourceType } } : {}),
      context: {
        requestId: request.requestId ?? null,
        ipAddress: request.ip ?? null,
      },
    });

    return true;
  }
}
