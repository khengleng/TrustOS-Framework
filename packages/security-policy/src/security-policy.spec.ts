import { describe, expect, it } from 'vitest';
import type { ApiError } from '@trustos/errors';
import { assertNoLeakedValues, assertSecretFieldsRedacted } from '@trustos/security-testing';
import {
  InMemoryRateLimiter,
  enforceRateLimit,
  rateLimitHeaders,
  rateLimitKey,
} from './rate-limit';
import {
  MIN_JWT_SECRET_LENGTH,
  SecurityPolicyError,
  loadSecurityPolicy,
  productionPolicyProblems,
  securityPolicySummary,
} from './load';
import { meetsAuthenticationLevel, securityPolicySchema } from './policy';
import {
  ChainedSecretSource,
  EnvironmentSecretSource,
  SAFE_IDENTIFIER_FIELDS,
  correlationHash,
  isSafeIdentifierField,
  isSecretFieldName,
  redactSecrets,
  requireSecret,
} from './secrets';

const base = { environment: 'production' as const, allowedIdentityProviders: ['oidc' as const] };

const productionContext = {
  oidcIssuerUrl: 'https://idp.example/realms/trustos',
  oidcClientId: 'trustos-api',
};

const productionPolicy = (overrides: Record<string, unknown> = {}) =>
  securityPolicySchema.parse({
    ...base,
    http: { hsts: true, csrfEnabled: true, corsOrigins: ['https://app.example'] },
    ...overrides,
  });

describe('policy shape', () => {
  it('parses with nothing but an environment', () => {
    const policy = securityPolicySchema.parse({ environment: 'development' });

    expect(policy.tokens.accessTokenSeconds).toBe(900);
    expect(policy.allowedIdentityProviders).toEqual(['local']);
    expect(policy.sessions.rotateRefreshTokens).toBe(true);
  });

  it('refuses to make refresh rotation optional', () => {
    // Rotation is the only way reuse can be detected, so there is no `false`.
    expect(
      securityPolicySchema.safeParse({
        environment: 'development',
        sessions: { rotateRefreshTokens: false },
      }).success,
    ).toBe(false);
  });

  it('refuses an idle timeout longer than the absolute lifetime', () => {
    const result = securityPolicySchema.safeParse({
      environment: 'development',
      sessions: { idleTimeoutSeconds: 7200, absoluteLifetimeSeconds: 3600 },
    });

    expect(result.success).toBe(false);
  });

  it('refuses an access token that outlives its refresh token', () => {
    const result = securityPolicySchema.safeParse({
      environment: 'development',
      tokens: { accessTokenSeconds: 3600, refreshTokenSeconds: 600 },
    });

    // Rotation would be pointless.
    expect(result.success).toBe(false);
  });

  it('refuses an unbounded session, because there is no such option', () => {
    expect(
      securityPolicySchema.safeParse({
        environment: 'development',
        sessions: { absoluteLifetimeSeconds: 10 * 365 * 24 * 60 * 60 },
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown key rather than ignoring it', () => {
    expect(
      securityPolicySchema.safeParse({ environment: 'development', tokens: { accessTtl: 900 } })
        .success,
    ).toBe(false);
  });

  it('orders authentication levels', () => {
    expect(meetsAuthenticationLevel('high', 'medium')).toBe(true);
    expect(meetsAuthenticationLevel('medium', 'high')).toBe(false);
    expect(meetsAuthenticationLevel('low', 'low')).toBe(true);
  });
});

describe('production invariants', () => {
  it('accepts a correctly configured production policy', () => {
    expect(productionPolicyProblems(productionPolicy(), productionContext)).toEqual([]);
  });

  it('says nothing about a non-production policy', () => {
    const development = securityPolicySchema.parse({ environment: 'development' });
    expect(productionPolicyProblems(development)).toEqual([]);
  });

  it('refuses the development identity provider in production', () => {
    const problems = productionPolicyProblems(
      securityPolicySchema.parse({
        ...base,
        allowedIdentityProviders: ['local'],
        http: { hsts: true },
      }),
      { localJwtSecret: 'a'.repeat(40), localJwtRefreshSecret: 'b'.repeat(40) },
    );

    expect(problems.some((problem) => problem.includes('intended for development'))).toBe(true);
  });

  it('refuses two providers that could both authenticate one request', () => {
    // The security of the system would be the weaker of the two.
    const problems = productionPolicyProblems(
      securityPolicySchema.parse({
        ...base,
        allowedIdentityProviders: ['local', 'oidc'],
        http: { hsts: true },
      }),
      productionContext,
    );

    expect(problems.some((problem) => problem.includes('authenticable by the weaker'))).toBe(true);
  });

  it('accepts the local provider when a deployment says so explicitly', () => {
    // An internal tool with six users is a legitimate case; stumbling into it is not.
    const policy = loadSecurityPolicy(
      { ...base, allowedIdentityProviders: ['local'], http: { hsts: true } },
      {
        allowLocalIdentityInProduction: true,
        localJwtSecret: 'a'.repeat(40),
        localJwtRefreshSecret: 'b'.repeat(40),
      },
    );

    expect(policy.allowedIdentityProviders).toEqual(['local']);
  });

  it('requires an https issuer and a client id for OIDC', () => {
    expect(
      productionPolicyProblems(productionPolicy(), { oidcClientId: 'trustos-api' }),
    ).toContainEqual(expect.stringContaining('OIDC_ISSUER_URL: required'));

    expect(
      productionPolicyProblems(productionPolicy(), {
        oidcIssuerUrl: 'http://idp.example/realms/trustos',
        oidcClientId: 'trustos-api',
      }),
      // Token validation over plain http means an attacker on the path chooses the
      // signing keys.
    ).toContainEqual(expect.stringContaining('must be https'));

    expect(
      productionPolicyProblems(productionPolicy(), {
        oidcIssuerUrl: 'https://idp.example/realms/trustos',
      }),
    ).toContainEqual(expect.stringContaining('OIDC_CLIENT_ID: required'));
  });

  it('refuses an access token long enough to matter after a revocation', () => {
    const problems = productionPolicyProblems(
      productionPolicy({ tokens: { accessTokenSeconds: 3600 } }),
      productionContext,
    );

    expect(problems.some((problem) => problem.includes('accessTokenSeconds'))).toBe(true);
  });

  it('refuses a weak, placeholder or shared local secret', () => {
    const localPolicy = securityPolicySchema.parse({
      ...base,
      allowedIdentityProviders: ['local'],
      http: { hsts: true },
    });

    const short = productionPolicyProblems(localPolicy, {
      localJwtSecret: 'too-short',
      localJwtRefreshSecret: 'b'.repeat(40),
    });
    expect(short.some((problem) => problem.includes(`at least ${MIN_JWT_SECRET_LENGTH}`))).toBe(
      true,
    );

    const placeholder = productionPolicyProblems(localPolicy, {
      localJwtSecret: 'development-only-jwt-secret-change-me-please',
      localJwtRefreshSecret: 'b'.repeat(40),
    });
    expect(placeholder.some((problem) => problem.includes('placeholder secrets'))).toBe(true);

    const shared = productionPolicyProblems(localPolicy, {
      localJwtSecret: 'a'.repeat(40),
      localJwtRefreshSecret: 'a'.repeat(40),
    });
    // A leaked access-token key must not be able to mint refresh tokens.
    expect(shared.some((problem) => problem.includes('must differ'))).toBe(true);
  });

  it('never puts a secret value in a problem message', () => {
    const secret = 'this-is-the-actual-secret-value-1234567890';
    const problems = productionPolicyProblems(
      securityPolicySchema.parse({
        ...base,
        allowedIdentityProviders: ['local'],
        http: { hsts: true },
      }),
      { localJwtSecret: secret, localJwtRefreshSecret: secret },
    );

    expect(problems.join('\n')).not.toContain(secret);
  });

  it('refuses wildcard and plain-http CORS origins, and requires HSTS and CSRF', () => {
    const problems = productionPolicyProblems(
      securityPolicySchema.parse({
        ...base,
        http: { corsOrigins: ['*', 'http://app.example'], hsts: false, csrfEnabled: false },
      }),
      productionContext,
    );

    expect(problems.some((problem) => problem.includes('"*" is not permitted'))).toBe(true);
    expect(problems.some((problem) => problem.includes('plain-http origins'))).toBe(true);
    expect(problems.some((problem) => problem.includes('http.hsts'))).toBe(true);
    expect(problems.some((problem) => problem.includes('http.csrfEnabled'))).toBe(true);
  });
});

describe('loadSecurityPolicy', () => {
  it('throws with every problem listed, rather than the first', () => {
    try {
      loadSecurityPolicy({ ...base, http: { hsts: false, csrfEnabled: false } }, productionContext);
      expect.unreachable('should have thrown');
    } catch (error) {
      const policyError = error as SecurityPolicyError;
      expect(policyError.problems.length).toBeGreaterThan(1);
      expect(policyError.message).toContain('will not start');
    }
  });

  it('reports a malformed policy as a schema problem', () => {
    expect(() => loadSecurityPolicy({ environment: 'nonsense' })).toThrowError(SecurityPolicyError);
  });
});

describe('securityPolicySummary', () => {
  it('renders lifetimes and limits, and carries no secret value', () => {
    const summary = securityPolicySummary(productionPolicy());

    expect(summary.identityProviders).toEqual(['oidc']);

    /*
     * Asserted on *values*, not on field names: `apiKeys` and `passwords` are
     * legitimate names for limit groups, and a name-based check would either fail on
     * them or be weakened until it caught nothing. What must not appear is a secret,
     * and the policy type has nowhere to put one — the summary is built from limits.
     */
    assertNoLeakedValues(
      summary,
      ['a'.repeat(40), 'this-is-the-actual-secret-value'],
      'the summary',
    );
    assertSecretFieldsRedacted(
      { ...summary, apiKeys: undefined, passwords: undefined },
      'the summary',
    );

    // The count, not the list, so a summary shown to an administrator does not
    // enumerate every deployment's origins.
    expect((summary.http as Record<string, unknown>).corsOriginCount).toBe(1);
  });

  it('states that forced rotation is deliberately absent', () => {
    const summary = securityPolicySummary(productionPolicy());
    expect(JSON.stringify(summary)).toContain('predictable increments');
  });
});

describe('rate limiting', () => {
  function build() {
    let current = new Date('2026-01-01T00:00:00.000Z').getTime();
    const limiter = new InMemoryRateLimiter(() => new Date(current));
    return { limiter, advance: (seconds: number) => void (current += seconds * 1000) };
  }

  const rule = { limit: 3, windowSeconds: 60 };

  it('permits up to the limit and then refuses', async () => {
    const { limiter } = build();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await limiter.consume('key', rule)).allowed).toBe(true);
    }

    const refused = await limiter.consume('key', rule);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('resets when the window passes', async () => {
    const { limiter, advance } = build();

    for (let attempt = 0; attempt < 4; attempt += 1) await limiter.consume('key', rule);
    advance(61);

    expect((await limiter.consume('key', rule)).allowed).toBe(true);
  });

  it('counts each key separately', async () => {
    const { limiter } = build();

    for (let attempt = 0; attempt < 4; attempt += 1) await limiter.consume('one', rule);

    expect((await limiter.consume('two', rule)).allowed).toBe(true);
  });

  it('clears a key, so a legitimate user is not punished for a typo', async () => {
    const { limiter } = build();

    for (let attempt = 0; attempt < 3; attempt += 1) await limiter.consume('key', rule);
    await limiter.reset('key');

    expect((await limiter.consume('key', rule)).allowed).toBe(true);
  });

  it('sweeps expired windows rather than growing without limit', async () => {
    const { limiter, advance } = build();

    await limiter.consume('one', rule);
    await limiter.consume('two', rule);
    expect(limiter.size()).toBe(2);

    advance(61);
    await limiter.consume('three', rule);

    expect(limiter.size()).toBe(1);
  });

  it('throws the framework rate_limited error, with Retry-After in the context', async () => {
    const { limiter } = build();
    const policy = securityPolicySchema.parse({ environment: 'test' }).rateLimits;

    for (let attempt = 0; attempt < policy.login.limit; attempt += 1) {
      await enforceRateLimit(limiter, policy, 'login', 'identifier');
    }

    try {
      await enforceRateLimit(limiter, policy, 'login', 'identifier');
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.code).toBe('rate_limited');
      // The number belongs in a header, which the HTTP layer sets from the context.
      expect(apiError.context?.retryAfterSeconds).toBeGreaterThan(0);
      expect(apiError.context?.limitName).toBe('login');
    }
  });

  it('builds headers a client can act on', async () => {
    const { limiter } = build();
    const decision = await limiter.consume('key', rule);

    const headers = rateLimitHeaders(decision);
    expect(headers['RateLimit-Limit']).toBe('3');
    expect(headers['RateLimit-Remaining']).toBe('2');
    expect(headers['Retry-After']).toBeUndefined();

    for (let attempt = 0; attempt < 3; attempt += 1) await limiter.consume('key', rule);
    expect(rateLimitHeaders(await limiter.consume('key', rule))['Retry-After']).toBeTruthy();
  });

  it('cannot collide two different buckets into one', () => {
    // `login:a` + `b` and `login:` + `a:b` must not share a counter.
    expect(rateLimitKey('login', 'a:b')).not.toBe(rateLimitKey('login', 'a b'));
  });
});

describe('secret handling', () => {
  it('reads from the environment and reports a missing value as null', async () => {
    const source = new EnvironmentSecretSource({ JWT_SECRET: 'value', EMPTY: '' });

    expect(await source.read({ name: 'JWT_SECRET' })).toBe('value');
    // An empty value is missing, which is the case a naive check passes.
    expect(await source.read({ name: 'EMPTY' })).toBe(null);
    expect(await source.read({ name: 'ABSENT' })).toBe(null);
  });

  it('reads from the first source that has a value, in order', async () => {
    const chained = new ChainedSecretSource([
      new EnvironmentSecretSource({}),
      new EnvironmentSecretSource({ JWT_SECRET: 'from-second' }),
    ]);

    expect(await chained.read({ name: 'JWT_SECRET' })).toBe('from-second');
    expect(chained.id).toContain('chain');
  });

  it('names a missing secret without carrying its value', async () => {
    const source = new EnvironmentSecretSource({});

    try {
      await requireSecret(source, { name: 'JWT_SECRET' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.context?.secretName).toBe('JWT_SECRET');
      expect(apiError.message).toBe('The service is not fully configured.');
    }
  });

  it('recognises secret-looking field names', () => {
    for (const name of [
      'password',
      'X-Api-Key',
      'refresh_token',
      'clientSecret',
      'Authorization',
    ]) {
      expect(isSecretFieldName(name), name).toBe(true);
    }
    expect(isSecretFieldName('organizationId')).toBe(false);
  });

  it('redacts by field name, wherever the field sits', () => {
    const redacted = redactSecrets({
      organizationId: 'org_acme',
      auth: { token: 'eyJhbGciOi...', nested: { password: 'hunter2' } },
      keys: [{ apiKey: 'tos_live_abc' }],
    }) as Record<string, unknown>;

    expect(redacted.organizationId).toBe('org_acme');
    expect(JSON.stringify(redacted)).not.toContain('eyJhbGciOi');
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
    expect(JSON.stringify(redacted)).not.toContain('tos_live_abc');
  });

  it('survives a cycle, because the error path has to work', () => {
    const cyclic: Record<string, unknown> = { name: 'value' };
    cyclic.self = cyclic;

    // A redactor that can be made to recurse forever is a denial of service in the
    // one path that has to work.
    expect(() => redactSecrets(cyclic)).not.toThrow();
    expect(JSON.stringify(redactSecrets(cyclic))).toContain('circular');
  });

  it('truncates beyond its depth limit rather than recursing', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let level = 0; level < 20; level += 1) deep = { nested: deep };

    expect(JSON.stringify(redactSecrets(deep))).toContain('truncated');
  });

  it('serialises a date and an error rather than walking into them', () => {
    const redacted = redactSecrets({
      at: new Date('2026-01-01T00:00:00.000Z'),
      failure: new Error('went wrong'),
    }) as Record<string, unknown>;

    expect(redacted.at).toBe('2026-01-01T00:00:00.000Z');
    expect(redacted.failure).toEqual({ name: 'Error', message: 'went wrong' });
  });

  it('correlates an identifier without holding it', () => {
    const salt = 'deployment-salt';

    expect(correlationHash('Ada@Example.test', salt)).toBe(
      correlationHash('ada@example.test', salt),
    );
    expect(correlationHash('ada@example.test', salt)).not.toBe(
      correlationHash('ada@example.test', 'another-salt'),
    );
    expect(correlationHash('ada@example.test', salt)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the safe-identifier allow-list', () => {
  it('keeps an identifier derived from a secret, so a session can still be revoked', () => {
    const redacted = redactSecrets({
      sessionId: 'sess_abc',
      keyPrefix: 'tos_live_ab',
      credentialPrefix: 'tos_sa_abcdef',
      credentialType: 'local',
      familyId: 'fam_1',
      tokenId: 'jti_1',
    }) as Record<string, unknown>;

    // A trail of revocable sessions with the ids stripped out is a trail nobody can
    // act on.
    expect(redacted).toEqual({
      sessionId: 'sess_abc',
      keyPrefix: 'tos_live_ab',
      credentialPrefix: 'tos_sa_abcdef',
      credentialType: 'local',
      familyId: 'fam_1',
      tokenId: 'jti_1',
    });
  });

  it('still redacts the credential itself, whatever it is called', () => {
    const redacted = redactSecrets({
      sessionToken: 'the-actual-token',
      credential: 'tos_sa_the-actual-credential',
      apiKey: 'tos_live_the-actual-key',
      refreshToken: 'the-actual-refresh',
    });

    // A pattern list loose enough to let `sessionId` through would also let
    // `sessionToken` through, which is why there is an allow-list instead.
    assertNoLeakedValues(
      redacted,
      [
        'the-actual-token',
        'tos_sa_the-actual-credential',
        'tos_live_the-actual-key',
        'the-actual-refresh',
      ],
      'the redacted structure',
    );
  });

  it('keeps the allow-list short enough to review', () => {
    // Every entry is a security decision: the value must be useless to an attacker
    // who holds it. A list that grows unbounded stops being reviewed.
    expect(SAFE_IDENTIFIER_FIELDS.length).toBeLessThan(20);
    for (const field of SAFE_IDENTIFIER_FIELDS) {
      expect(isSafeIdentifierField(field)).toBe(true);
      expect(isSecretFieldName(field)).toBe(false);
    }
  });
});

describe('HSTS in production', () => {
  const productionInput = {
    environment: 'production' as const,
    allowedIdentityProviders: ['oidc' as const],
    tokens: { issuer: 'trustos', audience: 'trustos-api' },
    http: { corsOrigins: ['https://app.example.com'] },
  };

  const secrets = {
    oidcIssuerUrl: 'https://issuer.example.com',
    oidcClientId: 'trustos',
  };

  it('is on when the caller did not mention it', () => {
    /*
     * The schema has said "Forced on in production" since it was written and the loader refused
     * instead, so every application would have failed to start in production having to pass the
     * one value the policy permits in order to say it.
     */
    expect(loadSecurityPolicy(productionInput, secrets).http.hsts).toBe(true);
  });

  it('is still refused when the caller deliberately turns it off', () => {
    /*
     * The distinction that keeps the default from being a weakening. `hsts: false` in production is
     * a statement the policy disagrees with; not mentioning it is not.
     */
    expect(() =>
      loadSecurityPolicy(
        { ...productionInput, http: { ...productionInput.http, hsts: false } },
        secrets,
      ),
    ).toThrow(/hsts/);
  });

  it('stays off outside production when unmentioned', () => {
    // Development over plain HTTP with HSTS on is a browser that refuses to reach localhost again.
    const development = loadSecurityPolicy({
      ...productionInput,
      environment: 'development',
      allowedIdentityProviders: ['local'],
      http: { corsOrigins: ['http://localhost:3001'] },
    });

    expect(development.http.hsts).toBe(false);
  });
});
