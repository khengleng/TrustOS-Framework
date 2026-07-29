import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { ApiError } from '@trustos/errors';
import { ROUTE_METADATA } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';

/**
 * Marks a route as reachable without authentication.
 *
 * Every use is a deliberate hole in the perimeter, so keep the list short and
 * obvious: login, register, refresh, health.
 */
export const Public = () => SetMetadata(ROUTE_METADATA.PUBLIC, true);

/**
 * Injects the authenticated actor.
 *
 *   me(@CurrentUser() actor: ActorContext) { ... }
 */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ actor?: ActorContext | null }>();
  if (!request?.actor) throw ApiError.unauthorized();
  return request.actor;
});

/** Injects the actor, or null on a route that permits anonymous access. */
export const OptionalUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<{ actor?: ActorContext | null }>()?.actor ?? null;
});
