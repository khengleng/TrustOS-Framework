import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustsystem/errors';
import { ROUTE_METADATA } from '@trustsystem/rbac';
import type { SecurityEventEmitter } from '@trustsystem/security-events';
import type { ActorContext } from '@trustsystem/shared-types';
import type { CredentialAuthenticator, CredentialRequest } from '../authenticators';

/**
 * Authenticates a request from whatever credential it carries.
 *
 * Replaces `JwtAuthGuard` where a deployment uses the identity abstraction, and
 * keeps its contract: populate `request.actor` and nothing else. Authorization and
 * tenant scoping remain separate guards, so "who are you", "what may you do" and
 * "whose data is this" stay three individually testable decisions.
 *
 * The one rule worth stating: **exactly one authenticator resolves a request.**
 * The first that recognises the credential decides, and the rest are not
 * consulted. Two providers that could both authenticate the same request would
 * mean the security of the system is the weaker of the two — which is also why
 * `productionPolicyProblems` refuses `local` alongside `oidc` in production.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticators: CredentialAuthenticator[],
    private readonly options: {
      events?: SecurityEventEmitter;
      onActorResolved?: (actor: ActorContext) => void;
    } = {},
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.PUBLIC, targets);

    const http = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      method?: string;
      originalUrl?: string;
      url?: string;
      ip?: string;
      actor?: ActorContext | null;
      requestId?: string;
    }>();

    const request: CredentialRequest = {
      headers: http.headers,
      ipAddress: http.ip ?? null,
      userAgent: singleHeader(http.headers['user-agent']),
      requestId: http.requestId ?? null,
      method: http.method ?? 'GET',
      path: http.originalUrl ?? http.url ?? '/',
    };

    for (const authenticator of this.authenticators) {
      const actor = await authenticator.authenticate(request);
      if (!actor) continue;

      http.actor = actor;
      this.options.onActorResolved?.(actor);
      return true;
    }

    // No authenticator recognised a credential.
    if (isPublic) {
      http.actor = null;
      return true;
    }

    await this.options.events?.emit({
      type: 'auth.failed',
      result: 'failure',
      reason: 'no_credential',
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      requestId: request.requestId,
      context: { path: request.path, method: request.method },
    });

    throw ApiError.unauthorized();
  }
}

function singleHeader(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? null;
}
