import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustsystem/errors';
import { ROUTE_METADATA } from '@trustsystem/rbac';
import type { SecurityEventEmitter } from '@trustsystem/security-events';
import type { ActorContext } from '@trustsystem/shared-types';

/**
 * Blocks a service account from an interactive route.
 *
 * The complement of `@HumanActorsOnly()` in `@trustsystem/identity`, registered globally
 * so it covers the routes nobody remembered to decorate. Interactive paths are
 * matched by prefix — login, logout, password change, invitation acceptance, consent —
 * because those are the flows where a machine identity has no business, and because a
 * new one added under `/auth` should be covered without anyone thinking about it.
 *
 * A prefix match is coarse and that is the point: it fails closed for anything new
 * under a protected prefix, and the exception list is short and reviewable.
 */
@Injectable()
export class InteractiveRouteGuard implements CanActivate {
  /** Prefixes a machine identity may not reach. Matched after the global prefix. */
  static readonly DEFAULT_INTERACTIVE_PREFIXES = [
    '/auth/login',
    '/auth/logout',
    '/auth/register',
    '/auth/password',
    '/auth/mfa',
    '/auth/consent',
    '/invitations/accept',
    '/sessions/me',
  ];

  constructor(
    private readonly reflector: Reflector,
    private readonly options: {
      interactivePrefixes?: string[];
      events?: SecurityEventEmitter;
    } = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<{
      actor?: ActorContext | null;
      originalUrl?: string;
      url?: string;
    }>();

    const actor = request?.actor ?? null;
    if (!actor) return true;
    if (actor.actorType !== 'service_account' && actor.actorType !== 'api_key') return true;

    const path = request.originalUrl ?? request.url ?? '/';
    const prefixes =
      this.options.interactivePrefixes ?? InteractiveRouteGuard.DEFAULT_INTERACTIVE_PREFIXES;

    const matched = prefixes.find((prefix) => path.includes(prefix));
    if (!matched) return true;

    await this.options.events?.emit({
      type: 'service_account.interactive_login_blocked',
      result: 'blocked',
      reason: 'machine_actor_on_interactive_route',
      actorId: actor.userId,
      actorType: actor.actorType,
      organizationId: actor.organizationId,
      context: { path, matchedPrefix: matched },
    });

    throw ApiError.forbidden('This endpoint is for interactive use by a person.', {
      reason: 'machine_actor_on_interactive_route',
      actorType: actor.actorType,
    });
  }
}
