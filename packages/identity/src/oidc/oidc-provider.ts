import { createHash } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { MfaPolicy, TokenPolicy } from '@trustos/security-policy';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import {
  deriveAuthentication,
  type AuthenticationRequestMeta,
  type AuthenticationResult,
  type IdentityHealth,
  type IdentityProfile,
  type IdentityProvider,
  type LogoutRequest,
  type PasswordCredentials,
  type RoleMapping,
  type VerifiedIdentity,
} from '../provider';

/**
 * OpenID Connect identity provider, Keycloak-compatible.
 *
 * "Keycloak-compatible" rather than "Keycloak" is the design: everything here is
 * standard OIDC plus two Keycloak conventions that are read *if present* —
 * `realm_access.roles` and `resource_access.<client>.roles`. A provider that puts
 * roles in a flat `roles` claim works without changes, and nothing imports a
 * Keycloak SDK.
 *
 * The four validations that matter, and why each one is not optional:
 *
 *   **Signature** against the provider's published keys. A decoded-but-unverified
 *   token is an attacker-supplied JSON object.
 *
 *   **Issuer.** Without it, a token from any provider whose key happens to be
 *   fetchable is accepted.
 *
 *   **Audience.** Without it, a token minted for a *different* service in the same
 *   realm is accepted by this one — the mistake that turns one compromised
 *   low-value client into access everywhere.
 *
 *   **Algorithms.** Pinned to asymmetric algorithms. Without pinning, a token
 *   signed `alg: none`, or one signed with HMAC using the public key as the
 *   secret, verifies.
 *
 * Keys are fetched from JWKS and cached with a cooldown, so a rotation is picked
 * up automatically and an unknown `kid` cannot be used to hammer the provider.
 */

export interface OidcProviderConfig {
  /** Issuer URL, exactly as it appears in `iss`. */
  issuerUrl: string;
  /** JWKS endpoint. Defaults to the standard Keycloak/OIDC path. */
  jwksUri?: string;
  /** This service's client id, which must appear in `aud` or `azp`. */
  clientId: string;
  /**
   * Extra audiences to accept, for a deployment where the gateway's client id is
   * in `aud` rather than this service's.
   */
  additionalAudiences?: string[];
  /** End-session endpoint, for provider-side logout. */
  endSessionEndpoint?: string;
  /** Admin endpoint used for back-channel session revocation, when available. */
  sessionRevocationEndpoint?: string;
  /** Claim holding a flat role list, for providers that use one. */
  rolesClaim?: string;
  /** Claim holding group membership. Keycloak uses `groups`. */
  groupsClaim?: string;
  /** Claim carrying the organization, for a provider that models tenancy. */
  organizationClaim?: string;
  /** Maps provider role and group names onto TrustOS role names. */
  roleMap?: Record<string, string>;
  /** Provider roles or groups that mean platform staff. */
  superAdminRoles?: string[];
  /**
   * Fetch implementation, so the provider is testable without a network.
   *
   * Not optional in practice: every test in this repository supplies one, and
   * that is what makes the negative cases — wrong issuer, wrong audience, expired,
   * tampered — testable at all.
   */
  fetchJwks?: JWTVerifyGetKey;
}

interface KeycloakRealmAccess {
  roles?: string[];
}

interface KeycloakResourceAccess {
  [client: string]: { roles?: string[] } | undefined;
}

export class OidcIdentityProvider implements IdentityProvider {
  readonly id = 'oidc';
  readonly kind = 'oidc' as const;
  readonly supportsPasswordAuthentication = false;
  readonly supportsCentralSessionRevocation: boolean;

  private readonly jwks: JWTVerifyGetKey;
  private readonly audiences: string[];
  private lastKeyFetchAt: Date | null = null;
  private keyFetchFailures = 0;

  constructor(
    private readonly config: OidcProviderConfig,
    private readonly tokens: TokenPolicy,
    private readonly mfa: MfaPolicy,
  ) {
    const jwksUri =
      config.jwksUri ?? `${trimSlash(config.issuerUrl)}/protocol/openid-connect/certs`;

    this.jwks =
      config.fetchJwks ??
      createRemoteJWKSet(new URL(jwksUri), {
        // A rotation is picked up within the cooldown; an unknown `kid` cannot be
        // used to make this service hammer the identity provider.
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      });

    this.audiences = [config.clientId, ...(config.additionalAudiences ?? [])];
    this.supportsCentralSessionRevocation = Boolean(config.sessionRevocationEndpoint);
  }

  /**
   * Not supported, and it throws rather than returning a failure.
   *
   * With OIDC the browser authenticates against the identity provider directly —
   * authorization code flow with PKCE — and this service never sees a password.
   * A provider that quietly accepted one would be an invitation to build a second,
   * weaker login path beside the real one.
   */
  async authenticate(
    _credentials: PasswordCredentials,
    _meta: AuthenticationRequestMeta,
  ): Promise<AuthenticationResult> {
    throw ApiError.forbidden(
      'This deployment authenticates through its identity provider. Use the authorization code flow.',
      { reason: 'password_authentication_not_supported', provider: this.id },
    );
  }

  async validateAccessToken(token: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload;

    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuerUrl,
        audience: this.audiences,
        // Asymmetric only. `none` and the HMAC family are excluded, which is what
        // stops a token signed with the public key from verifying.
        algorithms: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'PS256'],
        clockTolerance: this.tokens.clockSkewSeconds,
      });
      payload = result.payload;
      this.lastKeyFetchAt = new Date();
      this.keyFetchFailures = 0;
    } catch (error) {
      // Only a failure to *retrieve* the provider's keys says anything about the
      // provider's health. A token that was refused is this working, and counting
      // refusals here meant anyone who could reach the API could mark identity
      // unhealthy — and, because the readiness indicator is critical, take the
      // instance out of rotation — by sending a handful of invalid bearer tokens.
      if (isKeyRetrievalFailure(error)) this.keyFetchFailures += 1;

      // The caller learns only that the token did not work. Which of the four
      // checks failed is operator detail, and telling an attacker which one is
      // how a token is iteratively repaired.
      throw ApiError.unauthorized(undefined, {
        reason: 'oidc_token_rejected',
        detail: error instanceof Error ? error.message : 'verification failed',
        issuer: this.config.issuerUrl,
      });
    }

    if (!payload.sub) {
      throw ApiError.unauthorized(undefined, { reason: 'oidc_token_without_subject' });
    }

    // `azp` is checked in addition to `aud`: Keycloak issues tokens whose `aud`
    // is a resource server while `azp` names the client that requested them, and
    // a deployment that only checks one of the two accepts tokens minted for
    // another client.
    const azp = typeof payload.azp === 'string' ? payload.azp : null;
    if (azp !== null && !this.audiences.includes(azp)) {
      throw ApiError.unauthorized(undefined, {
        reason: 'oidc_authorized_party_rejected',
        authorizedParty: azp,
      });
    }

    return this.toIdentity(payload, token);
  }

  /**
   * Reads a profile from the token rather than calling the provider.
   *
   * A userinfo round trip on every request is a hard dependency on the identity
   * provider's availability for something the token already contains. A deployment
   * that needs live status wires a `userinfo` call in its own provider subclass —
   * and accepts the coupling knowingly.
   */
  async getProfile(subject: string): Promise<IdentityProfile> {
    throw ApiError.internal(
      `Profile lookup is not implemented for the OIDC provider. The access token carries the profile; see docs/enterprise-identity.md. (subject: ${subject})`,
    );
  }

  /**
   * Provider-side logout.
   *
   * Only the local record can be cleared without a back channel; the provider's
   * own session outlives it. The end-session URL is what a browser is redirected
   * to, so this method returns rather than pretending to have done it, and
   * `endSessionUrl` is what the application actually uses.
   */
  async logout(request: LogoutRequest): Promise<void> {
    if (!this.config.endSessionEndpoint) {
      throw ApiError.internal(
        'No end-session endpoint is configured, so this provider cannot end a session centrally. Redirect the browser to the provider’s logout URL instead.',
      );
    }
    // Deliberately not a fetch. A back-channel logout that fails silently leaves
    // an administrator believing a session ended; the application performs the
    // redirect and observes the result.
    void request;
  }

  /** The URL a browser is redirected to in order to end the provider's session. */
  endSessionUrl(input: { idTokenHint?: string; postLogoutRedirectUri?: string }): string {
    if (!this.config.endSessionEndpoint) {
      throw ApiError.internal('No end-session endpoint is configured.');
    }

    const url = new URL(this.config.endSessionEndpoint);
    if (input.idTokenHint) url.searchParams.set('id_token_hint', input.idTokenHint);
    if (input.postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
    }
    url.searchParams.set('client_id', this.config.clientId);
    return url.toString();
  }

  async revokeSessions(subject: string): Promise<void> {
    if (!this.config.sessionRevocationEndpoint) {
      // Stated rather than swallowed. An administrator who clicks "revoke" and
      // gets a success they did not earn is worse off than one who is told the
      // provider has to be used.
      throw ApiError.internal(
        'This provider has no back-channel session revocation configured. Revoke the session in the identity provider, and revoke the local session record separately.',
      );
    }
    void subject;
    throw ApiError.internal(
      'Back-channel session revocation requires an administrative credential and is left to the deployment. See docs/enterprise-identity.md.',
    );
  }

  /**
   * Maps provider roles and groups onto TrustOS roles.
   *
   * Explicit mapping, not pass-through. A provider that could name a TrustOS role
   * directly would be able to grant `super_admin` by adding a realm role, which
   * makes the identity provider's role list an authorization boundary nobody
   * reviews. Anything unmapped is reported, so a misconfiguration is visible
   * rather than silently ignored.
   */
  mapRoles(identity: VerifiedIdentity): RoleMapping {
    const map = this.config.roleMap ?? {};
    const superAdminRoles = (this.config.superAdminRoles ?? []).map((role) => role.toLowerCase());

    const provided = [...identity.providerRoles, ...identity.providerGroups];
    const roles = new Set<string>();
    const unmapped: string[] = [];
    let isSuperAdmin = false;

    for (const value of provided) {
      const normalized = value.replace(/^\//, '');

      if (superAdminRoles.includes(normalized.toLowerCase())) {
        isSuperAdmin = true;
        continue;
      }

      const mapped = map[normalized] ?? map[value];
      if (mapped) roles.add(mapped);
      else unmapped.push(value);
    }

    const organizationClaim = this.config.organizationClaim;
    const organizationId =
      organizationClaim && typeof identity.claims[organizationClaim] === 'string'
        ? (identity.claims[organizationClaim] as string)
        : null;

    return { roles: [...roles].sort(), isSuperAdmin, organizationId, unmapped };
  }

  async health(): Promise<IdentityHealth> {
    // No probe request. Health is reported from what token validation has already
    // observed, because a readiness check that calls the identity provider on
    // every poll is a way to be rate-limited by it.
    const ok = this.keyFetchFailures < 5;

    return {
      ok,
      detail: ok
        ? this.lastKeyFetchAt
          ? `keys verified at ${this.lastKeyFetchAt.toISOString()}`
          : 'no token validated yet'
        : `${this.keyFetchFailures} consecutive token verification failures`,
      metadata: {
        issuer: this.config.issuerUrl,
        clientId: this.config.clientId,
        audiences: this.audiences,
        centralRevocation: this.supportsCentralSessionRevocation,
      },
    };
  }

  // --- internals ------------------------------------------------------------

  private toIdentity(payload: JWTPayload, token: string): VerifiedIdentity {
    const realmRoles = readRealmRoles(payload);
    const clientRoles = readClientRoles(payload, this.config.clientId);
    const flatRoles = this.config.rolesClaim
      ? readStringArray(payload[this.config.rolesClaim])
      : [];
    const groups = readStringArray(payload[this.config.groupsClaim ?? 'groups']);

    const amr = readStringArray(payload.amr);
    const acr = typeof payload.acr === 'string' ? payload.acr : null;

    return {
      subject: payload.sub as string,
      email: typeof payload.email === 'string' ? payload.email : null,
      emailVerified: payload.email_verified === true,
      displayName:
        typeof payload.name === 'string'
          ? payload.name
          : typeof payload.preferred_username === 'string'
            ? payload.preferred_username
            : null,
      providerRoles: [...new Set([...realmRoles, ...clientRoles, ...flatRoles])].sort(),
      providerGroups: groups,
      // `jti` is not mandatory in an OIDC access token. Falling back to a hash of
      // the token keeps session binding possible without inventing an id that two
      // different tokens could share.
      tokenId: typeof payload.jti === 'string' ? payload.jti : tokenFingerprint(token),
      issuer: typeof payload.iss === 'string' ? payload.iss : this.config.issuerUrl,
      audiences: readStringArray(payload.aud),
      issuedAt: payload.iat ? new Date(payload.iat * 1000) : null,
      expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
      authentication: deriveAuthentication({
        acr,
        amr,
        authenticatedAt:
          typeof payload.auth_time === 'number' ? new Date(payload.auth_time * 1000) : null,
        multiFactorAcrValues: this.mfa.multiFactorAcrValues,
        multiFactorAmrValues: this.mfa.multiFactorAmrValues,
      }),
      // Keycloak disables a user at the realm; a token already issued stays valid
      // until it expires. Short access-token lifetimes are the control, and
      // `docs/enterprise-identity.md` says so.
      active: true,
      claims: Object.freeze({ ...payload }),
      provider: this.id,
      providerKind: this.kind,
    };
  }
}

/**
 * Whether the provider's key material could not be retrieved.
 *
 * Distinct from a token that was checked against keys we hold and correctly refused:
 * an expired token, a bad signature, a `kid` the realm does not publish. Those say the
 * provider is working, and treating them as provider faults turns readiness into
 * something an anonymous caller can switch off.
 *
 * The classification is deliberately narrow — an unrecognised error does not count as
 * an outage. A real outage produces a timeout or a network error reliably, so nothing
 * is missed by refusing to guess; whereas defaulting the unknown case to "unhealthy"
 * restores exactly the denial of service this exists to prevent.
 */
function isKeyRetrievalFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as Error & { code?: string }).code;

  // jose signals a JWKS endpoint that did not answer in time.
  if (code === 'ERR_JWKS_TIMEOUT') return true;

  // An unreachable endpoint surfaces as the runtime's own fetch failure, which
  // carries no jose code.
  if (
    error.name === 'TypeError' &&
    /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message)
  ) {
    return true;
  }

  return Boolean(
    code === undefined &&
    /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(error.message),
  );
}

function readRealmRoles(payload: JWTPayload): string[] {
  const realmAccess = payload.realm_access as KeycloakRealmAccess | undefined;
  return readStringArray(realmAccess?.roles);
}

function readClientRoles(payload: JWTPayload, clientId: string): string[] {
  const resourceAccess = payload.resource_access as KeycloakResourceAccess | undefined;
  return readStringArray(resourceAccess?.[clientId]?.roles);
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * A stable id for a token with no `jti`.
 *
 * A hash of the token, truncated. Not a secret — it is derived from a value the
 * bearer already holds — but it must never be logged, because the full token
 * would be recoverable by anyone who could enumerate candidates. It is used only
 * as a session key.
 */
function tokenFingerprint(token: string): string {
  return `tf_${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}
