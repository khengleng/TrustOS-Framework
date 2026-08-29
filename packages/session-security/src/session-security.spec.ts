import { describe, expect, it } from 'vitest';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustos/security-events';
import { securityPolicySchema } from '@trustos/security-policy';
import { assertNoLeakedValues } from '@trustos/security-testing';
import { checkCsrf, issueCsrfToken, isSafeMethod, verifyCsrfToken } from './csrf';
import {
  buildCookie,
  evaluateCors,
  securityHeaders,
  securityHeadersMiddleware,
} from './http-security';
import { InMemorySessionStore } from './in-memory-store';
import { SessionService, describeDevice, hashRefreshToken } from './sessions';

const policy = securityPolicySchema.parse({ environment: 'test' });

interface Harness {
  service: SessionService;
  store: InMemorySessionStore;
  sink: InMemorySecurityEventSink;
  advance: (seconds: number) => void;
  suspicious: Array<{ reason: string }>;
}

function build(overrides: Partial<typeof policy.sessions> = {}): Harness {
  const store = new InMemorySessionStore();
  const sink = new InMemorySecurityEventSink();
  const suspicious: Array<{ reason: string }> = [];

  let current = new Date('2026-01-01T00:00:00.000Z').getTime();

  const service = new SessionService({
    store,
    policy: { ...policy.sessions, ...overrides },
    events: new SecurityEventEmitter({ sinks: [sink], application: 'test' }),
    correlationSalt: 'test-salt',
    onSuspicious: (event) => void suspicious.push({ reason: event.reason }),
    now: () => new Date(current),
  });

  return {
    service,
    store,
    sink,
    suspicious,
    advance: (seconds) => void (current += seconds * 1000),
  };
}

const start = (harness: Harness, overrides: Record<string, unknown> = {}) =>
  harness.service.start({
    userId: 'user_ada',
    clientId: 'web',
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120',
    ipAddress: '203.0.113.9',
    organizationId: 'org_acme',
    refreshToken: 'refresh-token-1',
    refreshTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  });

describe('starting a session', () => {
  it('records the session and the refresh token hash, never the token', async () => {
    const harness = build();
    const session = await start(harness);

    expect(session.userId).toBe('user_ada');
    expect(session.deviceLabel).toBe('Chrome on macOS');

    const snapshot = harness.store.snapshot();
    expect(snapshot.refreshTokens[0]?.tokenHash).toBe(hashRefreshToken('refresh-token-1'));
    // The raw token must appear nowhere in the store or the event trail.
    assertNoLeakedValues(snapshot, ['refresh-token-1'], 'the session store');
    assertNoLeakedValues(harness.sink.events, ['refresh-token-1'], 'the event trail');
  });

  it('stores a correlation hash of the address rather than the address', async () => {
    const harness = build();
    const session = await start(harness);

    // "The same source, again" is answerable; a list of customer IP addresses is not
    // recoverable from the table.
    expect(session.ipHash).not.toBe('203.0.113.9');
    expect(session.ipHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records the authentication strength for later step-up decisions', async () => {
    const harness = build();
    const session = await start(harness, { mfaCompleted: true, authenticationLevel: 'high' });

    expect(session.mfaCompleted).toBe(true);
    expect(session.authenticationLevel).toBe('high');
  });
});

describe('refresh-token rotation', () => {
  it('rotates on use and keeps the session alive', async () => {
    const harness = build();
    await start(harness);

    harness.advance(60);
    const session = await harness.service.rotate({
      presentedToken: 'refresh-token-1',
      newToken: 'refresh-token-2',
      newTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(session.revokedAt).toBe(null);
    expect(harness.sink.byType('session.refresh_rotated')).toHaveLength(1);

    const snapshot = harness.store.snapshot();
    const used = snapshot.refreshTokens.find(
      (token) => token.tokenHash === hashRefreshToken('refresh-token-1'),
    );
    expect(used?.usedAt).toBeInstanceOf(Date);
    expect(used?.replacedByHash).toBe(hashRefreshToken('refresh-token-2'));
  });

  it('detects reuse and kills the whole family', async () => {
    const harness = build();
    await start(harness);

    await harness.service.rotate({
      presentedToken: 'refresh-token-1',
      newToken: 'refresh-token-2',
      newTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    // The same token again. Either the client retried after a network failure or an
    // attacker is replaying a stolen token, and the request cannot tell them apart —
    // so the family dies.
    await expect(
      harness.service.rotate({
        presentedToken: 'refresh-token-1',
        newToken: 'refresh-token-3',
        newTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow(/sign in again/i);

    const snapshot = harness.store.snapshot();
    expect(snapshot.sessions[0]?.revokedReason).toBe('reuse_detected');
    expect(snapshot.refreshTokens.every((token) => token.revokedAt !== null)).toBe(true);

    // Recorded as critical, because this is what a stolen refresh token looks like.
    const event = harness.sink.byType('session.refresh_reuse_detected')[0];
    expect(event?.severity).toBe('critical');
    expect(harness.suspicious).toEqual([{ reason: 'refresh_token_reuse' }]);
  });

  it('refuses the token that replaced a reused one, too', async () => {
    const harness = build();
    await start(harness);

    await harness.service.rotate({
      presentedToken: 'refresh-token-1',
      newToken: 'refresh-token-2',
      newTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    await harness.service
      .rotate({
        presentedToken: 'refresh-token-1',
        newToken: 'refresh-token-3',
        newTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
      })
      .catch(() => undefined);

    // The legitimate user is signed out as well. That cost is deliberate: the
    // alternative is a stolen token that keeps working alongside the real one.
    await expect(
      harness.service.rotate({
        presentedToken: 'refresh-token-2',
        newToken: 'refresh-token-4',
        newTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow();
  });

  it('refuses an unknown token with the same error as a reused one', async () => {
    const harness = build();
    await start(harness);

    // A holder of a stolen token must not learn that reuse detection just fired.
    const errors: string[] = [];
    for (const token of ['never-issued', 'refresh-token-1']) {
      await harness.service
        .rotate({
          presentedToken: token,
          newToken: 'next',
          newTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
        })
        .catch((error: Error) => errors.push(error.message));
    }

    expect(errors).toHaveLength(1);
  });

  it('refuses an expired refresh token', async () => {
    const harness = build();
    await start(harness, { refreshTokenExpiresAt: new Date('2026-01-01T00:00:30.000Z') });

    harness.advance(60);

    await expect(
      harness.service.rotate({
        presentedToken: 'refresh-token-1',
        newToken: 'next',
        newTokenExpiresAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ).rejects.toThrow();
  });
});

describe('session limits', () => {
  it('ends a session that has been idle too long', async () => {
    const harness = build({ idleTimeoutSeconds: 60 });
    const session = await start(harness);

    harness.advance(120);

    await expect(harness.service.touch(session.id)).rejects.toThrow(/sign in again/i);
    expect(harness.sink.byType('session.idle_timeout')).toHaveLength(1);
  });

  it('ends a session at its absolute lifetime, however active it has been', async () => {
    const harness = build({ idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 120 });
    const session = await start(harness);

    // Kept alive by activity, which is exactly the case an idle timeout misses.
    harness.advance(60);
    await harness.service.touch(session.id);
    harness.advance(90);

    await expect(harness.service.touch(session.id)).rejects.toThrow();
    expect(harness.sink.byType('session.absolute_timeout')).toHaveLength(1);
  });

  it('evicts the oldest session rather than refusing the newest', async () => {
    const harness = build({ maxConcurrentSessions: 2 });

    const first = await start(harness, { refreshToken: 'r1' });
    harness.advance(10);
    await start(harness, { refreshToken: 'r2' });
    harness.advance(10);
    // Signing in on a new device must never be denied — that is a support call and a
    // user who disables the feature.
    const third = await start(harness, { refreshToken: 'r3' });

    expect(third.revokedAt).toBe(null);
    expect((await harness.store.findSession(first.id))?.revokedReason).toBe('concurrency_limit');
    expect(harness.sink.byType('session.concurrency_evicted')).toHaveLength(1);
  });

  it('refuses to use a revoked session', async () => {
    const harness = build();
    const session = await start(harness);

    await harness.service.revoke(session.id, 'administrative');

    await expect(harness.service.touch(session.id)).rejects.toThrow();
  });
});

describe('revocation', () => {
  it('revokes one session and its refresh family', async () => {
    const harness = build();
    const session = await start(harness);

    await harness.service.revoke(session.id, 'logout');

    const snapshot = harness.store.snapshot();
    expect(snapshot.sessions[0]?.revokedAt).toBeInstanceOf(Date);
    expect(snapshot.refreshTokens.every((token) => token.revokedAt !== null)).toBe(true);
    expect(harness.sink.byType('session.revoked')).toHaveLength(1);
  });

  it('is idempotent, because it is used during an incident', async () => {
    const harness = build();
    const session = await start(harness);

    await harness.service.revoke(session.id, 'logout');
    await harness.service.revoke(session.id, 'logout');

    expect(harness.sink.byType('session.revoked')).toHaveLength(1);
  });

  it('signs out everywhere', async () => {
    const harness = build();
    await start(harness, { refreshToken: 'r1' });
    await start(harness, { refreshToken: 'r2' });

    const count = await harness.service.revokeAll('user_ada', 'logout_all');

    expect(count).toBe(2);
    expect(await harness.service.list('user_ada')).toHaveLength(0);
    expect(harness.store.snapshot().refreshTokens.every((token) => token.revokedAt)).toBe(true);
  });

  it('lists sessions with the current one marked, and no hashes', async () => {
    const harness = build();
    const session = await start(harness);

    const listed = await harness.service.list('user_ada', session.id);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.current).toBe(true);
    expect(listed[0]?.deviceLabel).toBe('Chrome on macOS');
    // A person's device list must not contain a hash they cannot use or interpret.
    expect(JSON.stringify(listed)).not.toContain('ipHash');
  });
});

describe('describeDevice', () => {
  it('produces a label a person recognises, not a fingerprint', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120')).toBe('Chrome on Windows');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605')).toBe(
      'Safari on iOS',
    );
    expect(describeDevice('curl/8.4.0')).toBe('Command line');
    expect(describeDevice(null)).toBe(null);
  });
});

describe('security headers', () => {
  const headers = (environment: 'development' | 'production', overrides = {}) =>
    securityHeaders({
      policy: { ...policy.http, hsts: environment === 'production', ...overrides },
      environment,
    });

  it('adds an extra source to a directive that already exists', () => {
    // A browser application has to reach its identity provider for the discovery
    // document and the token exchange, and `connect-src 'self'` blocks both.
    const csp =
      headers('production', {
        contentSecurityPolicyExtras: { 'connect-src': ['https://idp.example'] },
      })['Content-Security-Policy'] ?? '';

    expect(csp).toContain("connect-src 'self' https://idp.example");
  });

  it('does not repeat a source the directive already had', () => {
    // Extras are additive, so a caller naming a source the default already carries
    // would otherwise emit it twice. Harmless to the browser, and corrosive to a
    // reviewer's trust in a header they are meant to read closely.
    const csp =
      headers('production', {
        contentSecurityPolicyExtras: { 'connect-src': ["'self'", 'https://idp.example'] },
      })['Content-Security-Policy'] ?? '';

    const connect = csp.split(';').find((part) => part.trim().startsWith('connect-src')) ?? '';

    expect(connect.match(/'self'/g)).toHaveLength(1);
    expect(connect).toContain('https://idp.example');
  });

  it('starts the content policy from nothing and adds only what is needed', () => {
    const csp = headers('production')['Content-Security-Policy'] ?? '';

    // A resource type nobody thought about is blocked rather than allowed.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('sends the headers that stop a browser being used against a session', () => {
    const result = headers('production');

    expect(result['X-Content-Type-Options']).toBe('nosniff');
    expect(result['Referrer-Policy']).toBe('no-referrer');
    expect(result['X-Frame-Options']).toBe('DENY');
    expect(result['Permissions-Policy']).toContain('camera=()');
    expect(result['Cross-Origin-Opener-Policy']).toBe('same-origin');
    // An authenticated response cached and served to the next person on a shared
    // machine is a session leak no other header prevents.
    expect(result['Cache-Control']).toBe('no-store');
  });

  it('sends HSTS in production and not in development', () => {
    expect(headers('production')['Strict-Transport-Security']).toContain('max-age=');
    // Sent in development it would pin localhost to https in the developer's browser.
    expect(headers('development')['Strict-Transport-Security']).toBeUndefined();
  });

  it('relaxes the content policy only on a named path', () => {
    const options = {
      policy: policy.http,
      environment: 'development' as const,
      relaxedPaths: ['/docs'],
    };

    expect(securityHeaders(options, '/docs')['Content-Security-Policy']).toContain(
      "'unsafe-inline'",
    );
    expect(securityHeaders(options, '/api/merchants')['Content-Security-Policy']).not.toContain(
      "'unsafe-inline'",
    );
  });
});

describe('CORS', () => {
  const withOrigins = (origins: string[]) => ({ ...policy.http, corsOrigins: origins });

  it('treats a request with no Origin as not a CORS request', () => {
    // A server-to-server call or a same-origin navigation. There is no browser to
    // constrain.
    const decision = evaluateCors(null, withOrigins([]));
    expect(decision.allowed).toBe(true);
    expect(decision.headers).toEqual({});
  });

  it('allows an allowlisted origin and echoes it exactly', () => {
    const decision = evaluateCors('https://app.test', withOrigins(['https://app.test']));

    expect(decision.allowed).toBe(true);
    // The specific origin, never `*`: `*` and Allow-Credentials are mutually
    // exclusive and browsers reject the pair.
    expect(decision.headers['Access-Control-Allow-Origin']).toBe('https://app.test');
    expect(decision.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(decision.headers.Vary).toBe('Origin');
  });

  it('refuses an origin that is not on the list', () => {
    const decision = evaluateCors('https://evil.test', withOrigins(['https://app.test']));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('origin_not_allowlisted');
    expect(decision.headers).toEqual({});
  });

  it('never reflects the request origin back', () => {
    // Echoing whatever the Origin header said, with credentials, permits every site
    // to make authenticated requests while looking like a policy.
    const decision = evaluateCors('https://evil.test', withOrigins([]));
    expect(decision.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('refuses a wildcard origin even if one reaches the policy at runtime', () => {
    const decision = evaluateCors('https://anything.test', withOrigins(['*']));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('wildcard_origin_not_permitted');
  });

  it('does not match a subdomain or a scheme it was not given', () => {
    const allowed = withOrigins(['https://app.test']);

    expect(evaluateCors('https://evil.app.test', allowed).allowed).toBe(false);
    expect(evaluateCors('http://app.test', allowed).allowed).toBe(false);
    expect(evaluateCors('https://app.test:8443', allowed).allowed).toBe(false);
  });
});

describe('cookies', () => {
  it('defaults to HttpOnly, Secure and SameSite=Lax', () => {
    const cookie = buildCookie({ name: 'trustos_refresh', value: 'x' }, 'production');

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('omits Secure in development, so a developer can use http://localhost', () => {
    expect(buildCookie({ name: 'a', value: 'b' }, 'development')).not.toContain('Secure');
  });

  it('refuses SameSite=None without Secure rather than emitting a dropped cookie', () => {
    expect(() =>
      buildCookie({ name: 'a', value: 'b', sameSite: 'None', secure: false }, 'production'),
    ).toThrowError(/requires Secure/);
  });
});

describe('CSRF', () => {
  const options = { secret: 'csrf-signing-secret', allowedOrigins: ['https://app.test'] };

  const request = (overrides: Record<string, unknown> = {}) => ({
    method: 'POST',
    headers: { origin: 'https://app.test' } as Record<string, string | string[] | undefined>,
    cookies: {} as Record<string, string | undefined>,
    sessionId: 'sess_1',
    cookieAuthenticated: true,
    ...overrides,
  });

  it('binds a token to a session, so one cannot be replayed into another', () => {
    const { token } = issueCsrfToken('sess_1', options.secret);

    expect(verifyCsrfToken(token, 'sess_1', options.secret)).toBe(true);
    // A plain random double-submit token is defeated by anyone who can set a cookie
    // on a sibling subdomain; the signature is what stops that.
    expect(verifyCsrfToken(token, 'sess_2', options.secret)).toBe(false);
    expect(verifyCsrfToken(token, 'sess_1', 'another-secret')).toBe(false);
  });

  it('skips a safe method', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(checkCsrf(request({ method: 'GET' }), options).ok).toBe(true);
  });

  it('skips a bearer-authenticated request, and says why', () => {
    // A cross-site page cannot set the Authorization header, so there is nothing to
    // forge.
    const decision = checkCsrf(request({ cookieAuthenticated: false }), options);

    expect(decision.ok).toBe(true);
    expect(decision.reason).toBe('bearer_authenticated');
  });

  it('accepts a matching, session-bound token from an allowlisted origin', () => {
    const { token } = issueCsrfToken('sess_1', options.secret);

    const decision = checkCsrf(
      request({
        headers: { origin: 'https://app.test', 'x-csrf-token': token },
        cookies: { trustos_csrf: token },
      }),
      options,
    );

    expect(decision.ok).toBe(true);
  });

  it('refuses a cross-site origin', () => {
    const { token } = issueCsrfToken('sess_1', options.secret);

    const decision = checkCsrf(
      request({
        headers: { origin: 'https://evil.test', 'x-csrf-token': token },
        cookies: { trustos_csrf: token },
      }),
      options,
    );

    expect(decision).toEqual({ ok: false, reason: 'origin_not_allowlisted' });
  });

  it('refuses a state-changing cookie request with no origin or referer', () => {
    const decision = checkCsrf(request({ headers: {} }), options);
    expect(decision.reason).toBe('missing_origin_and_referer');
  });

  it('falls back to the referer when there is no origin', () => {
    const { token } = issueCsrfToken('sess_1', options.secret);

    const decision = checkCsrf(
      request({
        headers: { referer: 'https://app.test/settings', 'x-csrf-token': token },
        cookies: { trustos_csrf: token },
      }),
      options,
    );

    expect(decision.ok).toBe(true);
  });

  it('refuses a missing or mismatched token', () => {
    const { token } = issueCsrfToken('sess_1', options.secret);

    expect(checkCsrf(request({ cookies: { trustos_csrf: token } }), options).reason).toBe(
      'csrf_token_missing',
    );

    expect(
      checkCsrf(
        request({
          headers: { origin: 'https://app.test', 'x-csrf-token': 'something-else' },
          cookies: { trustos_csrf: token },
        }),
        options,
      ).reason,
    ).toBe('csrf_token_mismatch');
  });

  it('refuses a token minted for another session', () => {
    const other = issueCsrfToken('sess_other', options.secret);

    const decision = checkCsrf(
      request({
        headers: { origin: 'https://app.test', 'x-csrf-token': other.token },
        cookies: { trustos_csrf: other.token },
      }),
      options,
    );

    // Well-formed, matching cookie and header, and still refused — this is the replay.
    expect(decision.reason).toBe('csrf_token_not_bound_to_session');
  });
});

describe('framework banner', () => {
  it('removes headers that name the server software', () => {
    /*
     * Free information for an attacker: it narrows which CVEs are worth trying, and a
     * response that volunteers its stack tends to volunteer other things. Found on the
     * deployed DEV runtime, which was answering `X-Powered-By: Express`.
     */
    const removed: string[] = [];
    const middleware = securityHeadersMiddleware({
      policy: securityPolicySchema.parse({ environment: 'test' }).http,
      environment: 'test',
    });

    middleware(
      { path: '/api/governance/approvals' },
      {
        setHeader: () => undefined,
        removeHeader: (name: string) => void removed.push(name),
      },
      () => undefined,
    );

    expect(removed).toContain('X-Powered-By');
    expect(removed).toContain('Server');
  });

  it('does not require the response to support removal', () => {
    // A response object without `removeHeader` must not throw — the middleware runs
    // against more than one server implementation.
    const middleware = securityHeadersMiddleware({
      policy: securityPolicySchema.parse({ environment: 'test' }).http,
      environment: 'test',
    });

    expect(() =>
      middleware({ path: '/' }, { setHeader: () => undefined }, () => undefined),
    ).not.toThrow();
  });
});
