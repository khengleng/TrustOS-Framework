import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustsystem/errors';
import { ROUTE_METADATA } from '@trustsystem/rbac';
import type { SecurityEventEmitter } from '@trustsystem/security-events';
import { isMachineActor, type ActorContext } from '@trustsystem/shared-types';
import { scopesSatisfyAll } from '../scopes';
import { SCOPE_METADATA } from './decorators';

/**
 * Enforces scope requirements on credential-based actors.
 *
 * Two rules that look asymmetric and are not:
 *
 *   A **human** actor is unaffected. People have no scopes; their access is roles
 *   and permissions, and applying a scope check to them would either block every
 *   person or be a no-op.
 *
 *   A **machine** actor on a route that declares *no* scope is **denied**. That is
 *   the important half: a credential is issued for a purpose, and an endpoint nobody
 *   scoped is an endpoint whose exposure to every existing key was never decided.
 *   The failure is loud in staging rather than silent in production.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly options: { events?: SecurityEventEmitter } = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<{ actor?: ActorContext | null }>();
    const actor = request?.actor ?? null;

    if (!actor) throw ApiError.unauthorized();
    if (!isMachineActor(actor)) return true;

    const required = this.reflector.getAllAndOverride<string[]>(SCOPE_METADATA.REQUIRED, targets);

    if (!required?.length) {
      await this.deny(actor, 'route_declares_no_scope', context, []);
      throw ApiError.forbidden('This endpoint is not available to credential-based callers.', {
        reason: 'route_declares_no_scope',
        hint: 'Add @RequireScopes(...) to make this route reachable by an API key or service account.',
        actorType: actor.actorType,
      });
    }

    if (!scopesSatisfyAll(actor.scopes ?? [], required)) {
      await this.deny(actor, 'scope_not_granted', context, required);
      throw ApiError.forbidden(`This credential is missing a required scope.`, {
        reason: 'scope_not_granted',
        requiredScopes: required,
        heldScopes: actor.scopes ?? [],
      });
    }

    return true;
  }

  private async deny(
    actor: ActorContext,
    reason: string,
    context: ExecutionContext,
    required: string[],
  ): Promise<void> {
    await this.options.events?.emit({
      type: 'api_key.scope_denied',
      result: 'blocked',
      reason,
      actorId: actor.userId,
      actorType: actor.actorType,
      organizationId: actor.organizationId,
      context: {
        requiredScopes: required,
        heldScopes: actor.scopes ?? [],
        handler: context.getHandler().name,
        controller: context.getClass().name,
      },
    });
  }
}
