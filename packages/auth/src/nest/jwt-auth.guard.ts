import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustsystem/errors';
import { ROUTE_METADATA } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { TokenService } from '../tokens';

/**
 * Optional hook for checking a token against a revocation list.
 *
 * Not implemented by default: the framework revokes by refresh-token family
 * and by `tokenVersion`, which needs no per-request lookup. When a product
 * needs immediate access-token revocation, implement this against Redis and
 * provide it — the guard already calls it.
 */
export interface TokenRevocationChecker {
  isRevoked(claims: { jti: string; sub: string; tv: number }): Promise<boolean> | boolean;
}

export interface JwtAuthGuardOptions {
  tokens: TokenService;
  revocationChecker?: TokenRevocationChecker;
  /** Called once the actor is resolved — used to enrich the log context. */
  onActorResolved?: (actor: ActorContext) => void;
}

/**
 * Authenticates a request from its `Authorization: Bearer` header.
 *
 * Populates `request.actor` and nothing else. Authorization (`PermissionsGuard`)
 * and tenant scoping (`TenantGuard`) are separate guards that run after it, so
 * that "who are you", "what may you do" and "whose data is this" stay three
 * distinct, individually testable decisions.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly options: JwtAuthGuardOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(ROUTE_METADATA.PUBLIC, targets);

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      actor?: ActorContext | null;
    }>();

    const token = readBearerToken(request.headers.authorization);

    if (!token) {
      if (isPublic) {
        request.actor = null;
        return true;
      }
      throw ApiError.unauthorized();
    }

    const claims = this.options.tokens.verifyAccessToken(token);

    if (this.options.revocationChecker) {
      const revoked = await this.options.revocationChecker.isRevoked({
        jti: claims.jti,
        sub: claims.sub,
        tv: claims.tv,
      });
      if (revoked) throw ApiError.unauthorized('Session expired. Please sign in again.');
    }

    const actor: ActorContext = {
      // A token minted by the local provider always represents a person. Machine
      // callers arrive through @trustsystem/api-keys or @trustsystem/service-accounts,
      // which set their own actor type — see @trustsystem/identity.
      actorType: 'user',
      userId: claims.sub,
      email: claims.email,
      organizationId: claims.org,
      roles: claims.roles ?? [],
      permissions: claims.perms ?? [],
      isSuperAdmin: Boolean(claims.sa),
      tokenId: claims.jti,
      provider: 'local',
      /*
       * The local provider has no second factor, so assurance is `low` and `mfa`
       * is false — stated rather than left undefined, so a route requiring MFA
       * refuses a local session instead of silently accepting one whose assurance
       * was never established.
       */
      authentication: {
        mfa: false,
        level: 'low',
        methods: ['pwd'],
        acr: null,
        authenticatedAt: claims.iat ? new Date(claims.iat * 1000) : null,
      },
    };

    request.actor = actor;
    this.options.onActorResolved?.(actor);
    return true;
  }
}

/**
 * Extracts a bearer token.
 *
 * Only the `Authorization` header is accepted — never a query parameter,
 * which would end up in access logs, browser history and referrer headers.
 */
export function readBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const [scheme, token] = value.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}
