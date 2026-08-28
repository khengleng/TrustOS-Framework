import type { HttpPolicy } from '@trustos/security-policy';

/**
 * HTTP hardening.
 *
 * These headers live in the session-security package rather than a package of their
 * own because that is what they protect: every one of them exists to stop a browser
 * being used against the session it holds. A bearer-token API served to no browser
 * needs almost none of them, which is the honest framing — they are not decoration,
 * they are session defence.
 *
 * `helmet` is not used, and the reason is not novelty: helmet's defaults change
 * between major versions, and a security header that silently changes on a dependency
 * bump is a control nobody reviewed. Twelve headers written out are twelve headers a
 * reviewer can read.
 */

export interface SecurityHeaderOptions {
  policy: HttpPolicy;
  environment: 'development' | 'test' | 'production';
  /**
   * Relax the content policy for a documentation UI.
   *
   * Swagger UI needs inline styles and, in some builds, inline scripts. Rather than
   * weakening the policy everywhere, the caller marks the one path that needs it —
   * and `/docs` is disabled in production by the framework's own config anyway.
   */
  relaxedPaths?: string[];
}

/**
 * The default content policy.
 *
 * `default-src 'none'` and then only what is needed. Starting from nothing means a
 * resource type nobody thought about is blocked rather than allowed, which is the
 * difference between a CSP that stops an injection and one that documents it.
 */
export function contentSecurityPolicy(options: {
  extras?: Record<string, string[]>;
  frameAncestors: string[];
  relaxed?: boolean;
}): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    // A JSON API serves no scripts. A relaxed path — the docs UI — needs its own.
    'script-src': options.relaxed ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': options.relaxed ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'base-uri': ["'none'"],
    // Stops a form on an injected page posting to a third party.
    'form-action': ["'self'"],
    // The modern replacement for X-Frame-Options; both are sent, because older
    // browsers only understand the header.
    'frame-ancestors': options.frameAncestors.length > 0 ? options.frameAncestors : ["'none'"],
    'object-src': ["'none'"],
    // Blocks a same-origin iframe from being navigated to a different origin.
    'frame-src': ["'none'"],
  };

  for (const [directive, sources] of Object.entries(options.extras ?? {})) {
    directives[directive] = [...(directives[directive] ?? []), ...sources];
  }

  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * The headers to send.
 *
 * Every entry has a one-line reason, because a header nobody can explain is a header
 * somebody eventually removes to fix a bug.
 */
export function securityHeaders(
  options: SecurityHeaderOptions,
  path = '/',
): Record<string, string> {
  const relaxed = (options.relaxedPaths ?? []).some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

  const headers: Record<string, string> = {
    // Stops a browser guessing a response is HTML and executing it.
    'X-Content-Type-Options': 'nosniff',

    // No referrer to another origin: a URL can carry an id, a token in a badly
    // built client, or simply which customer is being looked at.
    'Referrer-Policy': 'no-referrer',

    // Denies the powerful APIs outright. An API needs none of them, and a console
    // that does re-enables the one it needs.
    'Permissions-Policy':
      'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',

    // Legacy framing protection, for browsers that predate frame-ancestors.
    'X-Frame-Options': options.policy.frameAncestors.length > 0 ? 'SAMEORIGIN' : 'DENY',

    'Content-Security-Policy': contentSecurityPolicy({
      extras: options.policy.contentSecurityPolicyExtras,
      frameAncestors: options.policy.frameAncestors,
      relaxed,
    }),

    // Isolates this origin from cross-origin popups and embeds, so a window
    // reference cannot be used to reach into it.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',

    // A cached authenticated response served to the next person on a shared machine
    // is a session leak that no header above prevents.
    'Cache-Control': 'no-store',
  };

  // HSTS only over HTTPS, and only in production. Sent in development it would
  // pin `localhost` to https in the developer's browser, which is a confusing
  // half-day.
  if (options.policy.hsts && options.environment === 'production') {
    headers['Strict-Transport-Security'] =
      `max-age=${options.policy.hstsMaxAgeSeconds}; includeSubDomains`;
  }

  return headers;
}

/**
 * Express-style middleware applying the headers.
 *
 * Framework-agnostic on purpose — it takes and returns the minimum shape — so the
 * same function works in Nest, in a plain Express app and in a test.
 */
export function securityHeadersMiddleware(options: SecurityHeaderOptions) {
  return function trustosSecurityHeaders(
    request: { path?: string; url?: string },
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ): void {
    const path = request.path ?? request.url ?? '/';
    for (const [name, value] of Object.entries(securityHeaders(options, path))) {
      response.setHeader(name, value);
    }
    next();
  };
}

// ---------------------------------------------------------------------------

export interface CorsDecision {
  allowed: boolean;
  reason: string;
  headers: Record<string, string>;
}

/**
 * Evaluates a CORS request against the policy.
 *
 * Exact origin matching against a list. No wildcard, no pattern, no reflection of
 * whatever the `Origin` header said — the last of which is the common mistake:
 * echoing the request's origin back with `Allow-Credentials: true` permits every
 * site to make authenticated requests, which is the same as having no policy while
 * looking like having one.
 *
 * A request with no `Origin` is not a CORS request. It is a server-to-server call or
 * a same-origin navigation, and it is allowed through without CORS headers — the
 * browser is the thing CORS constrains, and there is no browser here.
 */
export function evaluateCors(
  origin: string | null,
  policy: HttpPolicy,
  options: { requestIdHeader?: string; allowedMethods?: string[] } = {},
): CorsDecision {
  if (!origin) {
    return { allowed: true, reason: 'not_a_cors_request', headers: {} };
  }

  if (policy.corsOrigins.includes('*')) {
    // Refused here as well as at start-up. Belt and braces: a policy assembled at
    // runtime, in a test, or by a future code path must not be able to reintroduce
    // it.
    return { allowed: false, reason: 'wildcard_origin_not_permitted', headers: {} };
  }

  if (!policy.corsOrigins.includes(origin)) {
    return { allowed: false, reason: 'origin_not_allowlisted', headers: {} };
  }

  return {
    allowed: true,
    reason: 'origin_allowlisted',
    headers: {
      // The specific origin, never `*`. `*` and `Allow-Credentials: true` are
      // mutually exclusive in the specification, and browsers reject the pair.
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': (
        options.allowedMethods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
      ).join(', '),
      'Access-Control-Allow-Headers': [
        'Authorization',
        'Content-Type',
        'X-API-Key',
        'X-CSRF-Token',
        options.requestIdHeader ?? 'X-Request-Id',
      ].join(', '),
      'Access-Control-Expose-Headers': [
        options.requestIdHeader ?? 'X-Request-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
      ].join(', '),
      'Access-Control-Max-Age': '600',
      // Two origins must never share a cached response.
      Vary: 'Origin',
    },
  };
}

// ---------------------------------------------------------------------------

export interface CookieOptions {
  name: string;
  value: string;
  maxAgeSeconds?: number;
  path?: string;
  domain?: string;
  sameSite?: 'Strict' | 'Lax' | 'None';
  httpOnly?: boolean;
  secure?: boolean;
}

/**
 * Builds a `Set-Cookie` value with secure defaults.
 *
 * `HttpOnly` and `SameSite=Lax` by default, `Secure` outside development, and a
 * narrow path. The defaults are the safe combination, and each has to be overridden
 * deliberately:
 *
 *   * `HttpOnly` — a cookie readable from JavaScript is a cookie an injected script
 *     exfiltrates. The one exception is a CSRF token, which *has* to be readable, and
 *     which is worthless on its own.
 *   * `SameSite=Lax` — blocks the cross-site POST that is the whole of CSRF, while
 *     still surviving a top-level navigation back into the application.
 *   * `SameSite=None` requires `Secure`, and the function refuses the pair without it
 *     rather than emitting a cookie the browser will silently drop.
 */
export function buildCookie(
  options: CookieOptions,
  environment: 'development' | 'test' | 'production',
): string {
  const sameSite = options.sameSite ?? 'Lax';
  const secure = options.secure ?? environment !== 'development';

  if (sameSite === 'None' && !secure) {
    throw new Error('SameSite=None requires Secure; the browser would drop this cookie.');
  }

  const parts = [`${options.name}=${options.value}`];

  parts.push(`Path=${options.path ?? '/'}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.httpOnly ?? true) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(`SameSite=${sameSite}`);

  return parts.join('; ');
}
