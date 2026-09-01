import type { SecurityEventEmitter } from '@trustsystem/security-events';
import {
  enforceRateLimit,
  type RateLimitPolicy,
  type RateLimiter,
} from '@trustsystem/security-policy';
import {
  readAuthorizationCredential,
  readHeader,
  type CredentialAuthenticator,
  type CredentialRequest,
} from '@trustsystem/identity';
import type { ActorContext } from '@trustsystem/shared-types';
import { parseApiKey } from './key';
import type { ApiKeyService } from './service';

/**
 * Authenticates a request presenting an API key.
 *
 * Two accepted forms, and the reason for both:
 *
 *   `Authorization: ApiKey tos_live_...`   the correct one, and what the docs use
 *   `X-API-Key: tos_live_...`              what every client library sends anyway
 *
 * Neither is a query parameter. A credential in a URL ends up in access logs,
 * browser history, referrer headers and error reports, and once it is there it
 * cannot be removed from all of them.
 *
 * Rate limited *before* the hash lookup, so an attacker cannot use the endpoint as
 * an oracle at database speed. The limit is keyed on the key prefix rather than the
 * whole key, which is the point: a prefix identifies the credential being guessed
 * at without the limiter holding the credential.
 */

export interface ApiKeyAuthenticatorOptions {
  service: ApiKeyService;
  /** Resolves an organization's roles and permissions for a key's actor. */
  resolveAccess: (
    organizationId: string,
  ) => Promise<{ roles: string[]; permissions: string[] } | null>;
  rateLimiter?: RateLimiter;
  rateLimits?: RateLimitPolicy;
  events?: SecurityEventEmitter;
}

export class ApiKeyAuthenticator implements CredentialAuthenticator {
  readonly id = 'api-key';

  constructor(private readonly options: ApiKeyAuthenticatorOptions) {}

  async authenticate(request: CredentialRequest): Promise<ActorContext | null> {
    const key =
      readAuthorizationCredential(request.headers, 'ApiKey') ??
      readHeader(request.headers, 'x-api-key');

    // Not ours. Returning null rather than throwing is what lets a bearer token and
    // an API key coexist without either failing because of the other.
    if (!key) return null;

    if (this.options.rateLimiter && this.options.rateLimits) {
      // Keyed on the prefix. Malformed keys share one bucket, which is correct:
      // a flood of garbage is one attacker, not thousands of credentials.
      const parsed = parseApiKey(key);
      await enforceRateLimit(
        this.options.rateLimiter,
        this.options.rateLimits,
        'apiKeyAuth',
        parsed?.prefix ?? 'malformed',
      );
    }

    const verified = await this.options.service.verify({
      key,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      requestId: request.requestId,
      resolveAccess: this.options.resolveAccess,
    });

    return verified.actor;
  }
}
