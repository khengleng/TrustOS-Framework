/**
 * Route metadata for identity requirements.
 *
 * Separate keys from `@trustos/rbac`'s, because they answer a different question:
 * RBAC asks "may this actor do this", identity asks "did this actor prove who they
 * are strongly enough". A route can pass one and fail the other.
 */
export const IDENTITY_METADATA = {
  /** Route requires a completed second factor. Set by `@RequireMfa()`. */
  REQUIRE_MFA: 'trustos:require-mfa',
  /** Minimum assurance. Set by `@RequireAuthenticationLevel(...)`. */
  REQUIRE_LEVEL: 'trustos:require-authentication-level',
  /** Route is for people only. Set by `@HumanActorsOnly()`. */
  HUMANS_ONLY: 'trustos:humans-only',
  /** Actor types permitted. Set by `@AllowActorTypes(...)`. */
  ACTOR_TYPES: 'trustos:actor-types',
} as const;
