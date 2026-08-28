import {
  readAuthorizationCredential,
  type CredentialAuthenticator,
  type CredentialRequest,
} from '@trustos/identity';
import type { ActorContext } from '@trustos/shared-types';
import { CREDENTIAL_PREFIX, type ServiceAccountService } from './service';

/**
 * Authenticates a request presenting a local service-account credential.
 *
 *   Authorization: ServiceAccount tos_sa_...
 *
 * A distinct scheme rather than reusing `ApiKey`, so the two credential types cannot
 * be confused in a log or a configuration file — and so an operator reading an access
 * log can tell an integration's own identity from a key somebody minted for it.
 *
 * In the OIDC mode this authenticator is not used at all: the provider issues a token
 * by the client-credentials grant, `@trustos/identity` verifies it, and
 * `resolveOidcClient` maps the client id onto the local record.
 */
export class ServiceAccountAuthenticator implements CredentialAuthenticator {
  readonly id = 'service-account';

  constructor(
    private readonly options: {
      service: ServiceAccountService;
      resolveAccess: (
        organizationId: string | null,
        roles: string[],
      ) => Promise<{ permissions: string[] } | null>;
    },
  ) {}

  async authenticate(request: CredentialRequest): Promise<ActorContext | null> {
    const credential = readAuthorizationCredential(request.headers, 'ServiceAccount');
    if (!credential) return null;

    // Shape-checked before a database round trip, and it means an `ApiKey`-scheme
    // credential sent under the wrong scheme is rejected rather than looked up.
    if (!credential.startsWith(`${CREDENTIAL_PREFIX}_`)) return null;

    const verified = await this.options.service.verifyCredential({
      credential,
      ipAddress: request.ipAddress,
      requestId: request.requestId,
      resolveAccess: this.options.resolveAccess,
    });

    return verified.actor;
  }
}
