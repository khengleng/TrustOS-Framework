import { z } from 'zod';

/**
 * The security policy.
 *
 * One typed, validated object holding every security decision an operator is
 * allowed to make: how long tokens live, how many failed logins are tolerated,
 * which identity providers may authenticate, which issuer and audience are
 * trusted, how long an API key may live.
 *
 * It exists as a separate package for two reasons. Every security control in the
 * framework needs some of these values, and none of them should read
 * `process.env` to get them — so a single validated object is passed in.
 * And a policy that is *data* can be printed, diffed and reviewed, which is what
 * `securityPolicySummary` is for.
 *
 * Defaults are the values a production deployment should be able to keep. Where
 * a default would be unsafe in production it is refused rather than defaulted —
 * see `productionPolicyProblems`.
 */

export const durationSecondsSchema = z.number().int().min(1);

/** How strongly a caller has proved who they are. */
export const authenticationLevelSchema = z.enum(['low', 'medium', 'high']);
export type AuthenticationLevel = z.infer<typeof authenticationLevelSchema>;

/** Ordering, so "at least medium" is a comparison rather than a lookup table. */
export const AUTHENTICATION_LEVEL_ORDER: Record<AuthenticationLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function meetsAuthenticationLevel(
  actual: AuthenticationLevel,
  required: AuthenticationLevel,
): boolean {
  return AUTHENTICATION_LEVEL_ORDER[actual] >= AUTHENTICATION_LEVEL_ORDER[required];
}

export const identityProviderKindSchema = z.enum(['local', 'oidc']);
export type IdentityProviderKind = z.infer<typeof identityProviderKindSchema>;

export const environmentSchema = z.enum(['development', 'test', 'production']);
export type PolicyEnvironment = z.infer<typeof environmentSchema>;

// ---------------------------------------------------------------------------

export const tokenPolicySchema = z
  .object({
    /**
     * Access-token lifetime.
     *
     * Short, because an access token carries a resolved permission set and
     * cannot be revoked before it expires. Fifteen minutes is the window in
     * which a revoked permission still works.
     */
    accessTokenSeconds: durationSecondsSchema.max(60 * 60).default(15 * 60),

    /** Refresh-token lifetime. Bounded, so a stolen token expires eventually. */
    refreshTokenSeconds: durationSecondsSchema.max(90 * 24 * 60 * 60).default(30 * 24 * 60 * 60),

    /**
     * Tolerated clock difference when validating `exp` / `nbf` / `iat`.
     *
     * Small on purpose: skew is a grace period during which an expired token is
     * still accepted, so a generous value is a quiet extension of every token
     * lifetime in the system.
     */
    clockSkewSeconds: z.number().int().min(0).max(300).default(30),

    /** Issuer that must appear in `iss`. Required in production. */
    issuer: z.string().min(1).default('trustos'),

    /** Audience that must appear in `aud`. Required in production. */
    audience: z.string().min(1).default('trustos-api'),
  })
  .strict();

export const sessionPolicySchema = z
  .object({
    /** A session with no activity for this long is over, whatever its expiry. */
    idleTimeoutSeconds: durationSecondsSchema.max(30 * 24 * 60 * 60).default(60 * 60),

    /**
     * Hard ceiling on a session, regardless of activity.
     *
     * There is no "unlimited" option. A session that never ends is a credential
     * with no expiry, and `productionPolicyProblems` refuses an absolute
     * lifetime long enough to be one in practice.
     */
    absoluteLifetimeSeconds: durationSecondsSchema
      .max(90 * 24 * 60 * 60)
      .default(30 * 24 * 60 * 60),

    /**
     * Concurrent sessions per user. The oldest is revoked when the limit is
     * reached, so signing in on a new device cannot be denied — but an attacker
     * cannot quietly accumulate sessions either.
     */
    maxConcurrentSessions: z.number().int().min(1).max(100).default(10),

    /** Rotate the refresh token on every use. Off is not an option. */
    rotateRefreshTokens: z.literal(true).default(true),
  })
  .strict();

export const lockoutPolicySchema = z
  .object({
    /** Failed attempts against one account before it is locked. */
    maxFailedAttempts: z.number().int().min(3).max(50).default(10),
    /** How long the lock lasts. */
    lockoutSeconds: durationSecondsSchema.max(24 * 60 * 60).default(15 * 60),
    /** Window over which failures are counted. */
    failureWindowSeconds: durationSecondsSchema.max(24 * 60 * 60).default(15 * 60),
  })
  .strict();

export const passwordPolicySchema = z
  .object({
    minLength: z.number().int().min(12).max(256).default(12),
    maxLength: z.number().int().min(64).max(1024).default(128),
    requireMixedCase: z.boolean().default(true),
    requireDigit: z.boolean().default(true),
    /**
     * Check candidate passwords against a breach corpus.
     *
     * An interface, not an implementation: the framework ships no breach list
     * and makes no network call. See `CompromisedPasswordChecker`.
     */
    checkCompromised: z.boolean().default(true),
    /**
     * Deliberately absent: forced rotation. NIST withdrew the recommendation
     * because periodic rotation produces predictable increments, and the
     * framework will not add a field that encourages it.
     */
    rotationDays: z.null().default(null),
  })
  .strict();

export const apiKeyPolicySchema = z
  .object({
    /** Longest life an API key may be given. */
    maxLifetimeSeconds: durationSecondsSchema
      .max(2 * 365 * 24 * 60 * 60)
      .default(365 * 24 * 60 * 60),
    /** Keys per organization. A ceiling bounds the blast radius of a leak. */
    maxKeysPerOrganization: z.number().int().min(1).max(1000).default(50),
    /** Require an expiry. A key with none is a permanent credential. */
    requireExpiry: z.boolean().default(true),
    /**
     * Grace period during which a rotated key still works, so a rotation does
     * not need a synchronised deploy on the client side.
     */
    rotationGraceSeconds: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60)
      .default(24 * 60 * 60),
  })
  .strict();

export const mfaPolicySchema = z
  .object({
    /** Roles that may not act without multi-factor authentication. */
    requiredForRoles: z
      .array(z.string().min(1).max(60))
      .default(['super_admin', 'organization_owner']),
    /** Minimum assurance for a route that declares none. */
    defaultRequiredLevel: authenticationLevelSchema.default('low'),
    /**
     * `acr` values the identity provider uses to mean "multi-factor".
     *
     * Keycloak's default step-up configuration reports `gold`; OIDC's own
     * registry defines `urn:mace:incommon:iap:silver`. A deployment adds
     * whatever its provider emits.
     */
    multiFactorAcrValues: z
      .array(z.string().min(1).max(120))
      .default(['gold', 'urn:mace:incommon:iap:silver', 'mfa']),
    /** `amr` values that count as a second factor. */
    multiFactorAmrValues: z
      .array(z.string().min(1).max(60))
      .default(['mfa', 'otp', 'totp', 'hwk', 'swk', 'webauthn', 'sms', 'pop']),
  })
  .strict();

export const rateLimitRuleSchema = z
  .object({
    /** Requests permitted per window. */
    limit: z.number().int().min(1).max(100_000),
    windowSeconds: durationSecondsSchema.max(24 * 60 * 60),
  })
  .strict();

export type RateLimitRule = z.infer<typeof rateLimitRuleSchema>;

/**
 * Named limits.
 *
 * The defaults are tight where an endpoint is a credential-guessing oracle and
 * loose where it is not. Login at 10 per 15 minutes per identifier is generous
 * for a person and hostile to a script.
 */
export const rateLimitPolicySchema = z
  .object({
    login: rateLimitRuleSchema.default({ limit: 10, windowSeconds: 15 * 60 }),
    refresh: rateLimitRuleSchema.default({ limit: 60, windowSeconds: 15 * 60 }),
    passwordReset: rateLimitRuleSchema.default({ limit: 5, windowSeconds: 60 * 60 }),
    apiKeyAuth: rateLimitRuleSchema.default({ limit: 600, windowSeconds: 60 }),
    invitationAccept: rateLimitRuleSchema.default({ limit: 10, windowSeconds: 60 * 60 }),
    adminSensitive: rateLimitRuleSchema.default({ limit: 30, windowSeconds: 60 * 60 }),
  })
  .strict();

export const httpPolicySchema = z
  .object({
    /** Exact origins permitted by CORS. `*` is refused in production. */
    corsOrigins: z.array(z.string().min(1).max(400)).default([]),
    /** Send `Strict-Transport-Security`. Forced on in production. */
    hsts: z.boolean().default(false),
    hstsMaxAgeSeconds: z
      .number()
      .int()
      .min(0)
      .max(2 * 365 * 24 * 60 * 60)
      .default(365 * 24 * 60 * 60),
    /** Frame embedding. `deny` unless a product genuinely needs framing. */
    frameAncestors: z.array(z.string().min(1).max(200)).default([]),
    /** Extra CSP sources an application needs, merged into the default policy. */
    contentSecurityPolicyExtras: z.record(z.string(), z.array(z.string())).default({}),
    /** Require CSRF protection on cookie-authenticated requests. */
    csrfEnabled: z.boolean().default(true),
  })
  .strict();

export const securityPolicySchema = z
  .object({
    environment: environmentSchema,
    /**
     * Providers permitted to authenticate a request.
     *
     * A list rather than a single value, because a deployment migrating to OIDC
     * runs both for a while. `productionPolicyProblems` refuses `local` in
     * production unless it is the only entry, so a deployment cannot end up
     * accepting a development credential alongside a real one by accident.
     */
    allowedIdentityProviders: z.array(identityProviderKindSchema).min(1).default(['local']),
    tokens: tokenPolicySchema.default({}),
    sessions: sessionPolicySchema.default({}),
    lockout: lockoutPolicySchema.default({}),
    passwords: passwordPolicySchema.default({}),
    apiKeys: apiKeyPolicySchema.default({}),
    mfa: mfaPolicySchema.default({}),
    rateLimits: rateLimitPolicySchema.default({}),
    http: httpPolicySchema.default({}),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.sessions.idleTimeoutSeconds > policy.sessions.absoluteLifetimeSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sessions', 'idleTimeoutSeconds'],
        message: 'Idle timeout cannot exceed the absolute session lifetime.',
      });
    }

    if (policy.tokens.accessTokenSeconds > policy.tokens.refreshTokenSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tokens', 'accessTokenSeconds'],
        message: 'An access token that outlives its refresh token makes rotation pointless.',
      });
    }

    if (policy.passwords.minLength > policy.passwords.maxLength) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passwords', 'minLength'],
        message: 'Minimum password length exceeds the maximum.',
      });
    }
  });

export type SecurityPolicy = z.infer<typeof securityPolicySchema>;
export type TokenPolicy = SecurityPolicy['tokens'];
export type SessionPolicy = SecurityPolicy['sessions'];
export type LockoutPolicy = SecurityPolicy['lockout'];
export type PasswordPolicy = SecurityPolicy['passwords'];
export type ApiKeyPolicy = SecurityPolicy['apiKeys'];
export type MfaPolicy = SecurityPolicy['mfa'];
export type RateLimitPolicy = SecurityPolicy['rateLimits'];
export type HttpPolicy = SecurityPolicy['http'];
export type RateLimitName = keyof RateLimitPolicy;
