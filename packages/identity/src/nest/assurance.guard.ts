import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustos/errors';
import { ROUTE_METADATA } from '@trustos/rbac';
import {
  meetsAuthenticationLevel,
  type AuthenticationLevel,
  type MfaPolicy,
} from '@trustos/security-policy';
import type { SecurityEventEmitter } from '@trustos/security-events';
import { isMachineActor, type ActorContext, type ActorType } from '@trustos/shared-types';
import { IDENTITY_METADATA } from './metadata';

/**
 * Enforces authentication assurance and actor type.
 *
 * Runs after the authentication guard and before the permission guard, because
 * the question it answers sits between theirs: the actor is known, and the point
 * is whether they proved it strongly enough for *this* route.
 *
 * Four checks, in this order:
 *
 *   1. **Actor type.** A route for people refuses a machine, and a
 *      machine-to-machine route refuses a person's session.
 *   2. **Explicit MFA requirement** from `@RequireMfa()`.
 *   3. **Explicit level requirement** from `@RequireAuthenticationLevel(...)`.
 *   4. **Policy-driven MFA for privileged roles** — a role listed in
 *      `mfa.requiredForRoles` may not act without a second factor, whatever the
 *      route declared. This is the check that catches the route nobody remembered
 *      to decorate.
 *
 * Machine actors are exempt from 2, 3 and 4, and that is a deliberate decision
 * rather than an oversight: an API key has no second factor, so applying an MFA
 * requirement to one either blocks every integration or is quietly ignored.
 * Restricting what a machine may reach is `@AllowActorTypes` and scopes — see
 * `docs/authorization-model.md`.
 */
@Injectable()
export class AuthenticationAssuranceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mfaPolicy: MfaPolicy,
    private readonly options: { events?: SecurityEventEmitter } = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<{ actor?: ActorContext | null }>();
    const actor = request?.actor ?? null;

    // Authentication is the previous guard's job; reaching here with no actor
    // means the guards were registered in the wrong order.
    if (!actor) throw ApiError.unauthorized();

    // --- 1. actor type ------------------------------------------------------
    const humansOnly = this.reflector.getAllAndOverride<boolean>(
      IDENTITY_METADATA.HUMANS_ONLY,
      targets,
    );
    if (humansOnly && actor.actorType !== 'user') {
      await this.deny(actor, 'interactive_route_requires_human', context);
      throw ApiError.forbidden('This endpoint is for interactive use by a person.', {
        reason: 'interactive_route_requires_human',
        actorType: actor.actorType,
      });
    }

    const allowed = this.reflector.getAllAndOverride<ActorType[]>(
      IDENTITY_METADATA.ACTOR_TYPES,
      targets,
    );
    if (allowed?.length && !allowed.includes(actor.actorType)) {
      await this.deny(actor, 'actor_type_not_permitted', context);
      throw ApiError.forbidden(undefined, {
        reason: 'actor_type_not_permitted',
        actorType: actor.actorType,
        permitted: allowed,
      });
    }

    // Machines have no assurance to evaluate. Everything below is about people.
    if (isMachineActor(actor)) return true;

    const authentication = actor.authentication;

    // --- 2. explicit MFA ----------------------------------------------------
    const requireMfa = this.reflector.getAllAndOverride<boolean>(
      IDENTITY_METADATA.REQUIRE_MFA,
      targets,
    );
    if (requireMfa && !authentication?.mfa) {
      await this.deny(actor, 'mfa_required', context);
      throw mfaRequired();
    }

    // --- 3. explicit level --------------------------------------------------
    const requiredLevel =
      this.reflector.getAllAndOverride<AuthenticationLevel>(
        IDENTITY_METADATA.REQUIRE_LEVEL,
        targets,
      ) ?? this.mfaPolicy.defaultRequiredLevel;

    const actualLevel = authentication?.level ?? 'low';
    if (!meetsAuthenticationLevel(actualLevel, requiredLevel)) {
      await this.deny(actor, 'assurance_insufficient', context, {
        required: requiredLevel,
        actual: actualLevel,
      });
      throw ApiError.forbidden('Stronger authentication is required for this action.', {
        reason: 'assurance_insufficient',
        requiredLevel,
        actualLevel,
      });
    }

    // --- 4. privileged roles ------------------------------------------------
    const privileged = this.mfaPolicy.requiredForRoles.filter(
      (role) => actor.roles.includes(role) || (role === 'super_admin' && actor.isSuperAdmin),
    );

    if (privileged.length > 0 && !authentication?.mfa) {
      // The check that catches the route nobody decorated: a privileged role
      // cannot act at all without a second factor.
      await this.deny(actor, 'privileged_role_requires_mfa', context, { roles: privileged });
      throw mfaRequired();
    }

    return true;
  }

  private async deny(
    actor: ActorContext,
    reason: string,
    context: ExecutionContext,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.events?.emit({
      type:
        reason === 'mfa_required' || reason === 'privileged_role_requires_mfa'
          ? 'auth.mfa_required'
          : 'auth.assurance_insufficient',
      result: 'blocked',
      reason,
      actorId: actor.userId,
      actorType: actor.actorType,
      organizationId: actor.organizationId,
      provider: actor.provider ?? null,
      context: {
        handler: context.getHandler().name,
        controller: context.getClass().name,
        ...extra,
      },
    });
  }
}

/**
 * The error a missing second factor produces.
 *
 * `forbidden` rather than `unauthorized`, and the distinction is load-bearing for
 * a client: 401 means "your credential is not valid, sign in again", while this
 * means "your credential is valid but not strong enough, step up". A client that
 * receives 401 here would loop through a login that already succeeded.
 */
export function mfaRequired(): ApiError {
  return ApiError.forbidden('Multi-factor authentication is required for this action.', {
    reason: 'mfa_required',
    remedy: 'Complete a second factor with the identity provider and retry with the new token.',
  });
}
