import type {
  ActorAuthentication,
  ActorAuthenticationLevel,
  ActorContext,
} from '@trustsystem/shared-types';
import type { IdentityProviderKind } from '@trustsystem/security-policy';

/**
 * The identity abstraction.
 *
 * Application code consumes this and never a provider SDK. That is the whole
 * point of the package: swapping local authentication for Keycloak must be a
 * configuration change and a different implementation of one interface, not a
 * search-and-replace through every controller.
 *
 * The interface is deliberately wider than "verify a token". Logout, session
 * revocation and role mapping are all provider-specific in ways that leak into
 * application code if they are not abstracted — a Keycloak deployment revokes a
 * session at the realm, a local deployment revokes it in its own table, and a
 * controller that knows which is which is a controller that has to be rewritten.
 */

/** A subject as the provider knows it, before it becomes a TrustOS actor. */
export interface VerifiedIdentity {
  /** Provider's stable subject identifier. `sub` for OIDC. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;

  /** Roles exactly as the provider reported them, before mapping. */
  providerRoles: string[];
  /** Groups exactly as the provider reported them. */
  providerGroups: string[];

  /** Token identifier, so a session can be tied to it. */
  tokenId: string;
  issuer: string;
  audiences: string[];
  issuedAt: Date | null;
  expiresAt: Date | null;

  /** Authentication strength, derived from `acr` and `amr`. */
  authentication: ActorAuthentication;

  /** Whether the provider considers the account usable. */
  active: boolean;

  /**
   * Every claim, for a policy that needs one the framework does not model.
   *
   * Read-only by convention and never trusted for authorization on its own:
   * anything security-relevant is lifted into a named field above, where it has
   * been validated.
   */
  claims: Readonly<Record<string, unknown>>;

  /** Which provider verified this. */
  provider: string;
  providerKind: IdentityProviderKind;
}

/** What the provider knows about a subject, on request. */
export interface IdentityProfile {
  subject: string;
  email: string | null;
  displayName: string | null;
  active: boolean;
  providerRoles: string[];
  providerGroups: string[];
  /** When the provider last saw this subject authenticate, if it says. */
  lastAuthenticatedAt: Date | null;
}

export interface PasswordCredentials {
  email: string;
  password: string;
}

export interface AuthenticationRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  /** Which client is asking — a web app, a mobile app, a CLI. */
  clientId?: string | null;
}

export interface AuthenticationResult {
  identity: VerifiedIdentity;
  /** Issued tokens, when the provider issues them itself. */
  tokens?: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
  };
}

/** Mapping from provider roles and groups to TrustOS roles. */
export interface RoleMapping {
  /** TrustOS role names the subject holds. */
  roles: string[];
  /** True when the subject is platform staff. */
  isSuperAdmin: boolean;
  /** Organization the mapping resolved to, when the provider carries one. */
  organizationId: string | null;
  /** Provider values that matched nothing, for a misconfiguration report. */
  unmapped: string[];
}

export interface IdentityHealth {
  ok: boolean;
  /** Operator-facing detail. Never a secret, never a discovery document. */
  detail: string;
  /** Provider-specific facts an administrator wants: key count, cache age. */
  metadata?: Record<string, unknown>;
}

export interface LogoutRequest {
  subject: string;
  /** Session or token id, when logging out one session rather than all. */
  sessionId?: string;
  refreshToken?: string;
}

/**
 * A provider.
 *
 * Two methods can legitimately be unsupported, and they throw rather than return
 * a falsy value:
 *
 *   `authenticate` — an OIDC provider does not see a password. The browser talks
 *   to the identity provider directly, which is the point.
 *
 *   `revokeSessions` — a provider without a back-channel cannot revoke centrally,
 *   and pretending otherwise would leave an administrator believing a session was
 *   killed when it was not.
 */
export interface IdentityProvider {
  readonly id: string;
  readonly kind: IdentityProviderKind;

  /** True when `authenticate` is meaningful for this provider. */
  readonly supportsPasswordAuthentication: boolean;
  /** True when `revokeSessions` reaches the provider. */
  readonly supportsCentralSessionRevocation: boolean;

  authenticate(
    credentials: PasswordCredentials,
    meta: AuthenticationRequestMeta,
  ): Promise<AuthenticationResult>;

  /**
   * Verifies an access token and returns the subject.
   *
   * Must verify the signature, the issuer, the audience and the expiry. A
   * provider that decodes without verifying is the single most common way an
   * identity integration is broken, so `docs/enterprise-identity.md` states the
   * requirement and `@trustsystem/security-testing` tests it.
   */
  validateAccessToken(token: string): Promise<VerifiedIdentity>;

  getProfile(subject: string): Promise<IdentityProfile>;

  logout(request: LogoutRequest): Promise<void>;

  revokeSessions(subject: string): Promise<void>;

  mapRoles(identity: VerifiedIdentity): RoleMapping;

  health(): Promise<IdentityHealth>;
}

/**
 * Derives authentication strength from `acr` and `amr`.
 *
 * Shared by both providers so "did they use a second factor" is answered the same
 * way regardless of who authenticated them.
 *
 *   high   — a second factor was completed
 *   medium — a single factor, but recently and against a real identity provider
 *   low    — anything else, including a factor the framework cannot recognise
 *
 * Unrecognised values produce `low`, not `high`. An `acr` the deployment has not
 * configured means the framework does not know what happened, and the safe
 * reading of "I don't know" is "not strongly authenticated".
 */
export function deriveAuthentication(input: {
  acr: string | null;
  amr: string[];
  authenticatedAt: Date | null;
  multiFactorAcrValues: string[];
  multiFactorAmrValues: string[];
}): ActorAuthentication {
  const amr = input.amr.map((value) => value.toLowerCase());
  const acr = input.acr?.toLowerCase() ?? null;

  const acrMatch =
    acr !== null && input.multiFactorAcrValues.some((value) => value.toLowerCase() === acr);
  const amrMatch = input.multiFactorAmrValues.some((value) => amr.includes(value.toLowerCase()));

  const mfa = acrMatch || amrMatch;
  const level: ActorAuthenticationLevel = mfa ? 'high' : amr.length > 0 ? 'medium' : 'low';

  return {
    mfa,
    level,
    methods: input.amr,
    acr: input.acr,
    authenticatedAt: input.authenticatedAt,
  };
}

/**
 * Turns a verified identity plus a role mapping into a TrustOS actor.
 *
 * The one place a provider's view of a subject becomes the framework's view of an
 * actor. Note what is *not* taken from the token: `permissions` are resolved from
 * TrustOS roles by the caller, never read from a claim. A provider that could put
 * a permission in a token could grant itself anything.
 */
export function toActorContext(input: {
  identity: VerifiedIdentity;
  mapping: RoleMapping;
  /** Effective permissions, resolved from the mapped TrustOS roles. */
  permissions: string[];
  /** Organization this request is scoped to, after server-side validation. */
  organizationId: string | null;
  sessionId?: string | null;
}): ActorContext {
  return {
    actorType: 'user',
    userId: input.identity.subject,
    email: input.identity.email ?? '',
    organizationId: input.organizationId,
    roles: input.mapping.roles,
    permissions: input.permissions,
    isSuperAdmin: input.mapping.isSuperAdmin,
    tokenId: input.identity.tokenId,
    authentication: input.identity.authentication,
    provider: input.identity.provider,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}
