import { securityPolicySchema, type SecurityPolicy } from './policy';

/**
 * Loading and validating the policy.
 *
 * Two checks, and the separation matters. The schema says what is *well formed*;
 * `productionPolicyProblems` says what is *acceptable in production*. A value can
 * be perfectly well formed and still be a configuration nobody should ship — a
 * development identity provider, a wildcard CORS origin, a session that lasts a
 * quarter — and refusing those at start-up is the only reliable moment to do it.
 */

export class SecurityPolicyError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Security policy is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n\n` +
        'The application will not start with an unsafe security policy.',
    );
    this.name = 'SecurityPolicyError';
    this.problems = problems;
  }
}

/**
 * The longest session an operator can configure in production.
 *
 * Thirty days is already generous for a refresh token. Beyond it the token stops
 * being a session and becomes a long-lived credential with none of the handling a
 * long-lived credential needs.
 */
export const MAX_PRODUCTION_SESSION_SECONDS = 30 * 24 * 60 * 60;

/** Shortest access-token lifetime worth having, and the longest tolerable one. */
export const MAX_PRODUCTION_ACCESS_TOKEN_SECONDS = 30 * 60;

/** Minimum length for a locally signed JWT secret. */
export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Placeholder secrets that must never reach production.
 *
 * Duplicated from `@trustos/config` on purpose: this package validates a policy
 * that may be assembled without the config package at all — in a test, in a
 * worker, in a script — and a shared list that only one of them can see is a
 * check that silently does not run.
 */
export const FORBIDDEN_SECRETS = [
  'change-me',
  'changeme',
  'secret',
  'dev-secret',
  'development-only-jwt-secret-change-me-please',
  'development-only-refresh-secret-change-me-ok',
  'test-only-jwt-secret-not-for-any-real-usage',
  'test-only-refresh-secret-not-for-real-usage',
];

export interface PolicyValidationContext {
  /**
   * Secrets used by the local provider, so their strength can be checked
   * *without* this package ever storing or logging one.
   *
   * Only lengths and a lowercase comparison against the placeholder list are
   * read; no value is retained, and no value appears in a problem message.
   */
  localJwtSecret?: string;
  localJwtRefreshSecret?: string;
  /** Issuer discovery URL, when the OIDC provider is in use. */
  oidcIssuerUrl?: string;
  oidcClientId?: string;
}

/**
 * Production invariants a type cannot express.
 *
 * Every entry here is a configuration that boots, serves traffic, and is wrong.
 */
export function productionPolicyProblems(
  policy: SecurityPolicy,
  context: PolicyValidationContext = {},
): string[] {
  if (policy.environment !== 'production') return [];
  const problems: string[] = [];

  // --- identity providers ---------------------------------------------------
  if (policy.allowedIdentityProviders.includes('local')) {
    if (policy.allowedIdentityProviders.length > 1) {
      // Two providers that can both authenticate the same request means the
      // weaker one decides the security of the system.
      problems.push(
        'allowedIdentityProviders: "local" cannot be combined with another provider in production — a request would be authenticable by the weaker of the two.',
      );
    } else {
      problems.push(
        'allowedIdentityProviders: the local provider is intended for development, tests and lightweight deployments. Set IDENTITY_PROVIDER=oidc, or accept this explicitly with SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true.',
      );
    }
  }

  if (policy.allowedIdentityProviders.includes('oidc')) {
    if (!context.oidcIssuerUrl) {
      problems.push('OIDC_ISSUER_URL: required when the OIDC identity provider is enabled.');
    } else if (!context.oidcIssuerUrl.startsWith('https://')) {
      // Token validation over plain HTTP means an attacker on the path chooses
      // the signing keys.
      problems.push('OIDC_ISSUER_URL: must be https in production.');
    }
    if (!context.oidcClientId) {
      problems.push('OIDC_CLIENT_ID: required when the OIDC identity provider is enabled.');
    }
  }

  // --- tokens ---------------------------------------------------------------
  if (!policy.tokens.issuer.trim()) {
    problems.push('tokens.issuer: required. A token with no expected issuer accepts any issuer.');
  }
  if (!policy.tokens.audience.trim()) {
    problems.push(
      'tokens.audience: required. Without it a token minted for another service is accepted by this one.',
    );
  }
  if (policy.tokens.accessTokenSeconds > MAX_PRODUCTION_ACCESS_TOKEN_SECONDS) {
    problems.push(
      `tokens.accessTokenSeconds: at most ${MAX_PRODUCTION_ACCESS_TOKEN_SECONDS} in production — an access token carries a resolved permission set and cannot be revoked before it expires.`,
    );
  }

  // --- sessions -------------------------------------------------------------
  if (policy.sessions.absoluteLifetimeSeconds > MAX_PRODUCTION_SESSION_SECONDS) {
    problems.push(
      `sessions.absoluteLifetimeSeconds: at most ${MAX_PRODUCTION_SESSION_SECONDS} in production.`,
    );
  }

  // --- local secrets --------------------------------------------------------
  if (policy.allowedIdentityProviders.includes('local')) {
    for (const [name, value] of [
      ['JWT_SECRET', context.localJwtSecret],
      ['JWT_REFRESH_SECRET', context.localJwtRefreshSecret],
    ] as const) {
      if (value === undefined) continue;

      if (value.length < MIN_JWT_SECRET_LENGTH) {
        // The length is reported; the value never is.
        problems.push(
          `${name}: must be at least ${MIN_JWT_SECRET_LENGTH} characters in production.`,
        );
      }
      if (FORBIDDEN_SECRETS.includes(value.toLowerCase())) {
        problems.push(`${name}: placeholder secrets are not allowed in production.`);
      }
    }

    if (
      context.localJwtSecret !== undefined &&
      context.localJwtSecret === context.localJwtRefreshSecret
    ) {
      problems.push(
        'JWT_REFRESH_SECRET: must differ from JWT_SECRET so a leaked access-token key cannot mint refresh tokens.',
      );
    }
  }

  // --- HTTP -----------------------------------------------------------------
  if (policy.http.corsOrigins.includes('*')) {
    problems.push('http.corsOrigins: "*" is not permitted in production.');
  }
  if (policy.http.corsOrigins.some((origin) => origin.startsWith('http://'))) {
    problems.push('http.corsOrigins: plain-http origins are not permitted in production.');
  }
  if (!policy.http.hsts) {
    problems.push('http.hsts: must be enabled in production.');
  }
  if (!policy.http.csrfEnabled) {
    problems.push(
      'http.csrfEnabled: must be enabled in production. Bearer-token APIs are unaffected; cookie flows are not.',
    );
  }

  return problems;
}

export interface LoadSecurityPolicyOptions extends PolicyValidationContext {
  /**
   * Accept the local identity provider in production.
   *
   * Deliberately awkward: a lightweight internal deployment is a legitimate use,
   * and a deployment that stumbles into it is not. The flag makes the choice
   * appear in a diff.
   */
  allowLocalIdentityInProduction?: boolean;
}

/**
 * Parses and validates a policy, or throws.
 *
 * Called once, at start-up, before a port is bound.
 */
export function loadSecurityPolicy(
  input: unknown,
  options: LoadSecurityPolicyOptions = {},
): SecurityPolicy {
  const parsed = securityPolicySchema.safeParse(input);

  if (!parsed.success) {
    throw new SecurityPolicyError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  /*
   * HSTS is forced on in production when the caller did not mention it.
   *
   * The schema has said "Forced on in production" since it was written and the loader refused
   * instead, so every application in this repository would have failed to start in production with
   * `http.hsts: must be enabled in production` — each having to pass the one value the policy
   * permits in order to say it.
   *
   * The distinction that keeps this from being a weakening is between *unset* and *false*. A
   * deployment that says `hsts: false` in production still gets the refusal below, because that is
   * a deliberate statement the policy disagrees with. A deployment that did not mention it gets
   * the safe value rather than a startup failure.
   *
   * The raw input is inspected rather than the parsed policy, because the schema defaults `hsts`
   * to `false` and the two are indistinguishable afterwards.
   */
  const mentionedHsts =
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { http?: unknown }).http === 'object' &&
    (input as { http: Record<string, unknown> }).http !== null &&
    'hsts' in (input as { http: Record<string, unknown> }).http;

  const policy: SecurityPolicy =
    parsed.data.environment === 'production' && !mentionedHsts
      ? { ...parsed.data, http: { ...parsed.data.http, hsts: true } }
      : parsed.data;

  let problems = productionPolicyProblems(policy, options);

  if (options.allowLocalIdentityInProduction) {
    problems = problems.filter((problem) => !problem.includes('local provider is intended for'));
  }

  if (problems.length > 0) throw new SecurityPolicyError(problems);
  return policy;
}

/**
 * A summary safe to show an administrator.
 *
 * Lifetimes, limits and provider names — never a secret, never an issuer's
 * client secret, never a signing key. The security portal renders this.
 */
export function securityPolicySummary(policy: SecurityPolicy): Record<string, unknown> {
  return {
    environment: policy.environment,
    identityProviders: policy.allowedIdentityProviders,
    tokens: {
      accessTokenSeconds: policy.tokens.accessTokenSeconds,
      refreshTokenSeconds: policy.tokens.refreshTokenSeconds,
      clockSkewSeconds: policy.tokens.clockSkewSeconds,
      issuer: policy.tokens.issuer,
      audience: policy.tokens.audience,
    },
    sessions: {
      idleTimeoutSeconds: policy.sessions.idleTimeoutSeconds,
      absoluteLifetimeSeconds: policy.sessions.absoluteLifetimeSeconds,
      maxConcurrentSessions: policy.sessions.maxConcurrentSessions,
      rotateRefreshTokens: policy.sessions.rotateRefreshTokens,
    },
    lockout: policy.lockout,
    passwords: {
      minLength: policy.passwords.minLength,
      maxLength: policy.passwords.maxLength,
      requireMixedCase: policy.passwords.requireMixedCase,
      requireDigit: policy.passwords.requireDigit,
      checkCompromised: policy.passwords.checkCompromised,
      forcedRotation: 'not implemented — periodic rotation produces predictable increments',
    },
    apiKeys: policy.apiKeys,
    mfa: {
      requiredForRoles: policy.mfa.requiredForRoles,
      defaultRequiredLevel: policy.mfa.defaultRequiredLevel,
    },
    rateLimits: policy.rateLimits,
    http: {
      corsOriginCount: policy.http.corsOrigins.length,
      hsts: policy.http.hsts,
      csrfEnabled: policy.http.csrfEnabled,
      frameAncestors: policy.http.frameAncestors.length > 0 ? policy.http.frameAncestors : 'none',
    },
  };
}
