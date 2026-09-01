import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * Turning an authenticated enterprise identity into a TrustOS actor context.
 *
 * An SSO provider hands back a set of claims. Some of them are facts about who signed in — a
 * subject, a session, how strongly they proved it. Others are **assertions the provider is making
 * about authorization**: groups, roles, an organization. The two look identical in a JWT and they
 * are not remotely the same thing.
 *
 * So this package does one job, and the job is a refusal: **claims become an identity, never an
 * authorization.** `normalizeActor` returns who signed in. It returns an empty permission list,
 * always, because permissions come from the server-side membership lookup and nowhere else.
 *
 * Groups are mapped rather than copied. `mapGroupsToRoles` uses an explicit map and **reports
 * what it could not map**, because a provider that starts emitting `finance-team-v2` should
 * produce a visible gap rather than a person who silently lost access — or, worse, a person who
 * silently gained it because somebody wrote a permissive fallback.
 */

export const AUTHENTICATION_LEVELS = ['password', 'mfa', 'strong'] as const;
export type AuthenticationLevel = (typeof AUTHENTICATION_LEVELS)[number];

/**
 * The claims this package will read.
 *
 * A closed list. Anything else in the token is ignored — not rejected, ignored — because a
 * provider adds claims for its own reasons and a normalizer that failed on an unknown one would
 * break on a provider upgrade. What matters is that nothing outside this list can influence the
 * result.
 */
export const identityClaimsSchema = z
  .object({
    /** The stable subject. Never an email — an email is reassigned, a subject is not. */
    sub: z.string().min(1).max(200),
    /** The issuer. Verified before this point; carried so the audit record names it. */
    iss: z.string().min(1).max(400),
    /** Session identifier, where the provider issues one. */
    sid: z.string().min(1).max(200).optional(),
    /** How the person authenticated, as the provider reported it. */
    amr: z.array(z.string().max(40)).max(20).optional(),
    acr: z.string().max(80).optional(),
    /** Group membership, as the provider asserts it. Mapped, never copied. */
    groups: z.array(z.string().max(120)).max(200).optional(),
    /** Display name and email, for the UI. Never used for a decision. */
    name: z.string().max(200).optional(),
    email: z.string().max(320).optional(),
    exp: z.number().optional(),
  })
  .passthrough();

export type IdentityClaims = z.infer<typeof identityClaimsSchema>;

/**
 * The actor context an internal application runs as.
 *
 * `permissions` is here and is **always empty from this package**. It is on the type because the
 * gateway fills it in from the membership lookup, and having the field absent would mean every
 * consumer had to construct a second object — which is how a client-supplied list finds its way
 * in.
 */
export interface GovernanceActorContext {
  actorId: string;
  actorType: 'human' | 'service_account';
  /** From the server-side membership lookup. Never from a claim. */
  organizationId: string | null;
  roles: string[];
  permissions: string[];
  authenticationLevel: AuthenticationLevel;
  sessionId: string | null;
  /** The issuer that authenticated them. Recorded, never trusted for authorization. */
  issuer: string;
  /** Display only. */
  displayName: string | null;
  email: string | null;
}

export interface GroupMappingResult {
  roles: string[];
  /** Groups the map did not recognise. Reported so a provider change is visible, not silent. */
  unmapped: string[];
}

/**
 * Maps provider groups to internal roles.
 *
 * An explicit map, and no fallback. A `default` role for unmapped groups is the single most
 * tempting line in this file and the one that turns "somebody was added to a group in the
 * directory" into "somebody has access to the finance console".
 */
export function mapGroupsToRoles(
  groups: readonly string[],
  map: Readonly<Record<string, string>>,
): GroupMappingResult {
  const roles = new Set<string>();
  const unmapped: string[] = [];

  for (const group of groups) {
    const role = map[group];
    if (role) roles.add(role);
    else unmapped.push(group);
  }

  return { roles: [...roles].sort(), unmapped: unmapped.sort() };
}

/**
 * How strongly the person proved who they are.
 *
 * Derived from `amr`/`acr`, and **conservatively**: anything this function does not recognise is
 * `password`. Guessing upward would mean an unrecognised method reads as multi-factor, and the
 * assurance guard would let a privileged role through on a single factor.
 */
export function authenticationLevelFrom(claims: IdentityClaims): AuthenticationLevel {
  const methods = new Set((claims.amr ?? []).map((method) => method.toLowerCase()));

  if (methods.has('hwk') || methods.has('swk') || claims.acr?.includes('phishing-resistant')) {
    return 'strong';
  }

  if (methods.has('mfa') || methods.has('otp') || methods.has('sms') || methods.has('pwd_mfa')) {
    return 'mfa';
  }

  return 'password';
}

export interface NormalizeActorInput {
  claims: unknown;
  /** Provider group → internal role. Explicit, with no fallback. */
  groupRoleMap: Readonly<Record<string, string>>;
  /**
   * The server-side membership lookup.
   *
   * Returns the organization the person actually belongs to, or null. Required — a normalizer
   * that could run without one would be a normalizer that reads the organization from a claim.
   */
  resolveOrganization: (actorId: string) => Promise<string | null>;
  /** Issuers this deployment accepts. A correctly signed token from elsewhere is somebody else's. */
  allowedIssuers: readonly string[];
}

export async function normalizeActor(
  input: NormalizeActorInput,
): Promise<{ actor: GovernanceActorContext; unmappedGroups: string[] }> {
  const claims = identityClaimsSchema.parse(input.claims);

  if (!input.allowedIssuers.includes(claims.iss)) {
    throw new ApiError('unauthorized', {
      message: 'This token was issued by a provider this deployment does not accept.',
      context: { issuer: claims.iss },
    });
  }

  const organizationId = await input.resolveOrganization(claims.sub);
  const mapping = mapGroupsToRoles(claims.groups ?? [], input.groupRoleMap);

  return {
    actor: {
      actorId: claims.sub,
      actorType: 'human',
      /*
       * From the lookup. The token may well carry an `organization` claim; it is ignored, and
       * this package has no code path that reads one. An organization in a token is a request.
       */
      organizationId,
      roles: mapping.roles,
      /*
       * Always empty.
       *
       * Permissions are resolved per request, server-side, from the membership tables. Returning
       * them here would make the token the authorization decision, which is the failure this
       * whole package exists to make unreachable.
       */
      permissions: [],
      authenticationLevel: authenticationLevelFrom(claims),
      sessionId: claims.sid ?? null,
      issuer: claims.iss,
      displayName: claims.name ?? null,
      email: claims.email ?? null,
    },
    unmappedGroups: mapping.unmapped,
  };
}

/**
 * Refuses an actor with no organization.
 *
 * Called by the gateway before any handler runs. Somebody who authenticated successfully and
 * belongs to no organization is a real and normal state — a new joiner, a revoked membership —
 * and the honest answer is a clear refusal rather than a console rendered against nothing.
 */
export function assertTenantResolved(actor: GovernanceActorContext): string {
  if (!actor.organizationId) {
    throw new ApiError('forbidden', {
      message:
        'You are authenticated but belong to no organization in this deployment. Ask an ' +
        'administrator to add your membership.',
      context: { actorId: actor.actorId },
    });
  }

  return actor.organizationId;
}

/**
 * The audit metadata every action carries.
 *
 * Built once, here, so that a caller cannot assemble a partial one. The issuer and the session
 * are on it because "which identity provider authenticated this person, in which session" is the
 * first question of every access investigation, and reconstructing it later is impossible.
 */
export function actorAuditMetadata(actor: GovernanceActorContext): Record<string, string | null> {
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    organizationId: actor.organizationId,
    issuer: actor.issuer,
    sessionId: actor.sessionId,
    authenticationLevel: actor.authenticationLevel,
    /* Deliberately not the email or the name. An audit record is not a directory. */
  };
}
