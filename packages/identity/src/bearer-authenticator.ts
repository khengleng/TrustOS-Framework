import { ApiError } from '@trustos/errors';
import type { SecurityEventEmitter } from '@trustos/security-events';
import type { ActorContext } from '@trustos/shared-types';
import {
  readAuthorizationCredential,
  type CredentialAuthenticator,
  type CredentialRequest,
} from './authenticators';
import { toActorContext, type IdentityProvider } from './provider';

/**
 * Resolves an actor from a bearer token.
 *
 * What it does *not* do is as important as what it does: it never reads roles,
 * permissions or an organization from anything the client sent. The token's
 * subject is verified by the provider, the provider's roles are mapped to TrustOS
 * roles by an explicit map, and permissions are resolved from those roles
 * server-side. A provider that could put a permission in a token would otherwise
 * be able to grant itself anything.
 */

/** Resolves the effective access for a subject inside an organization. */
export interface AccessResolver {
  /**
   * Roles and permissions the subject holds in `organizationId`, or null when
   * they are not an active member.
   *
   * Called on every authenticated request that names an organization. That is a
   * lookup per request, and it is the price of not trusting a claim: a membership
   * revoked a minute ago has to stop working now, not when the token expires.
   */
  resolve(
    subject: string,
    organizationId: string | null,
  ): Promise<{ roles: string[]; permissions: string[]; isSuperAdmin: boolean } | null>;
}

export interface BearerAuthenticatorOptions {
  provider: IdentityProvider;
  access: AccessResolver;
  events?: SecurityEventEmitter;
  /**
   * Optional immediate-revocation check.
   *
   * The framework revokes by refresh-token family and by token version, neither
   * of which needs a per-request lookup — at the cost of a window equal to the
   * access-token lifetime. A deployment that cannot accept that window implements
   * this; the hook is called on every request.
   */
  revocationChecker?: {
    isRevoked(input: { tokenId: string; subject: string }): Promise<boolean> | boolean;
  };
}

export class BearerTokenAuthenticator implements CredentialAuthenticator {
  readonly id = 'bearer';

  constructor(private readonly options: BearerAuthenticatorOptions) {}

  async authenticate(request: CredentialRequest): Promise<ActorContext | null> {
    const token = readAuthorizationCredential(request.headers, 'Bearer');
    if (!token) return null;

    let identity;
    try {
      identity = await this.options.provider.validateAccessToken(token);
    } catch (error) {
      await this.options.events?.emit({
        type: 'auth.provider_rejected_token',
        result: 'failure',
        reason: reasonOf(error),
        provider: this.options.provider.id,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        requestId: request.requestId,
        context: { path: request.path, method: request.method },
      });
      throw error;
    }

    if (!identity.active) {
      await this.options.events?.emit({
        type: 'auth.failed',
        result: 'blocked',
        reason: 'subject_inactive',
        actorId: identity.subject,
        actorType: 'user',
        provider: identity.provider,
        ipAddress: request.ipAddress,
        requestId: request.requestId,
      });
      throw ApiError.unauthorized(undefined, { reason: 'subject_inactive' });
    }

    if (this.options.revocationChecker) {
      const revoked = await this.options.revocationChecker.isRevoked({
        tokenId: identity.tokenId,
        subject: identity.subject,
      });
      if (revoked) {
        await this.options.events?.emit({
          type: 'session.revoked',
          result: 'blocked',
          reason: 'token_revoked',
          actorId: identity.subject,
          actorType: 'user',
          provider: identity.provider,
          requestId: request.requestId,
        });
        throw ApiError.unauthorized('Session expired. Please sign in again.', {
          reason: 'token_revoked',
        });
      }
    }

    const mapping = this.options.provider.mapRoles(identity);

    if (mapping.unmapped.length > 0) {
      // A provider role nobody mapped is a misconfiguration, not an error: the
      // subject simply does not get whatever it was meant to grant. Recorded so
      // it is fixable, rather than producing a permission that quietly never
      // arrives.
      await this.options.events?.emit({
        type: 'identity.configuration_rejected',
        result: 'blocked',
        reason: 'unmapped_provider_roles',
        actorId: identity.subject,
        provider: identity.provider,
        requestId: request.requestId,
        context: { unmapped: mapping.unmapped },
      });
    }

    /*
     * The organization comes from the provider's own claim, if it has one, and is
     * then re-validated by `AccessResolver`. It is never read from a header — see
     * `@trustos/authorization` for the tenant-header attack this closes.
     */
    const organizationId = mapping.organizationId;
    const access = await this.options.access.resolve(identity.subject, organizationId);

    if (organizationId !== null && access === null) {
      await this.options.events?.emit({
        type: 'authz.inactive_member_blocked',
        result: 'blocked',
        reason: 'not_an_active_member',
        actorId: identity.subject,
        actorType: 'user',
        organizationId,
        provider: identity.provider,
        requestId: request.requestId,
      });
      throw ApiError.forbidden(undefined, { reason: 'not_an_active_member' });
    }

    return toActorContext({
      identity,
      mapping: {
        ...mapping,
        // Two independent sources of "is this platform staff": the provider's
        // mapped roles and the framework's own record. Either is sufficient, and
        // both are server-side.
        isSuperAdmin: mapping.isSuperAdmin || (access?.isSuperAdmin ?? false),
        roles: [...new Set([...mapping.roles, ...(access?.roles ?? [])])].sort(),
      },
      permissions: access?.permissions ?? [],
      organizationId,
    });
  }
}

function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'context' in error) {
    const context = (error as { context?: { reason?: string } }).context;
    if (context?.reason) return context.reason;
  }
  return 'token_rejected';
}
