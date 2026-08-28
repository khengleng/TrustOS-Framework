import type { OrganizationId, RequestId, UserId } from './ids';

/**
 * What kind of caller is acting.
 *
 * Every credential type resolves to the same `ActorContext`, which is what lets a
 * module, a guard or an audit record treat them uniformly — but the *type* has to
 * survive, for three reasons:
 *
 *   * An audit record that says "user X deleted this" when it was a machine is
 *     evidence pointing at the wrong party.
 *   * Some routes are for people only. An interactive login by a service account
 *     is a misuse to block and record, not a request to serve.
 *   * Authentication assurance means nothing for a machine. An API key has no
 *     second factor, so an MFA requirement has to be evaluated against the actor
 *     type rather than applied blindly.
 */
export type ActorType = 'user' | 'service_account' | 'api_key' | 'system';

/** How strongly the caller proved who they are. */
export type ActorAuthenticationLevel = 'low' | 'medium' | 'high';

/**
 * What the identity provider said about *how* this actor authenticated.
 *
 * Read from the token's `acr` and `amr` claims for an OIDC actor, and from the
 * local provider's own record otherwise. Never from anything the client supplied.
 */
export interface ActorAuthentication {
  /** True when a second factor was completed. */
  mfa: boolean;
  level: ActorAuthenticationLevel;
  /** Methods reported by the provider, e.g. ['pwd', 'otp']. */
  methods: string[];
  /** Raw `acr`, kept for policies that match on a provider-specific value. */
  acr: string | null;
  /** When the *authentication* happened, which is not when the token was issued. */
  authenticatedAt: Date | null;
}

/**
 * Who is acting. Populated by the authentication guard; absent on public routes.
 *
 * `permissions` is the effective, already-resolved permission set for the
 * actor **within `organizationId`**. Resolving it once per request keeps every
 * downstream check a pure set lookup.
 */
export interface ActorContext {
  /**
   * Which kind of caller this is. Required, so a new credential type cannot be
   * introduced without every consumer being made to think about it.
   */
  actorType: ActorType;
  /**
   * Stable identifier. A user id, a service-account id, or an API-key id
   * depending on `actorType` — the type says how to read it.
   */
  userId: UserId;
  email: string;
  /** The organization this request is scoped to, if the actor selected one. */
  organizationId: OrganizationId | null;
  roles: string[];
  permissions: string[];
  /** True for platform staff who may operate across organizations. */
  isSuperAdmin: boolean;
  /** JWT id of the access token, retained so it can be revoked. */
  tokenId: string;

  /**
   * Scopes, for credential-based actors.
   *
   * Empty for a human. An API key carries scopes *in addition to* permissions:
   * permissions say what the owning organization may do, scopes say what this
   * particular credential is allowed to do with them, and both must pass.
   */
  scopes?: string[];

  /** Authentication strength. Absent for a machine actor, which has none. */
  authentication?: ActorAuthentication;

  /** Identity provider that authenticated this actor, e.g. 'local' or 'oidc'. */
  provider?: string;

  /** Session this actor is acting within, when the credential has one. */
  sessionId?: string;
}

/** True for a caller that is a person. */
export function isHumanActor(actor: ActorContext | null): boolean {
  return actor?.actorType === 'user';
}

/** True for a caller that is a machine, whichever credential it presented. */
export function isMachineActor(actor: ActorContext | null): boolean {
  return actor !== null && (actor.actorType === 'service_account' || actor.actorType === 'api_key');
}

/** Everything about the transport-level request that logging and audit need. */
export interface RequestContext {
  requestId: RequestId;
  method: string;
  path: string;
  ipAddress: string | null;
  userAgent: string | null;
  receivedAt: Date;
  actor: ActorContext | null;
  /** Set once tenant resolution succeeds. Never trusted from the client body. */
  organizationId: OrganizationId | null;
}

export type ServiceEnvironment = 'development' | 'test' | 'production';
