import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';

/**
 * CSRF protection.
 *
 * **Why a bearer-token API needs none of this, and where the trap is.**
 *
 * CSRF works because a browser attaches cookies to a cross-site request
 * automatically. A bearer token is not attached automatically — some JavaScript has
 * to read it and set a header — and a cross-site page cannot read this origin's
 * storage. So a pure `Authorization: Bearer` API is not vulnerable, and adding CSRF
 * tokens to one is ceremony.
 *
 * The trap is that "we use bearer tokens" is often only mostly true. The moment a
 * refresh token is kept in a cookie so the page survives a reload — which is the
 * *recommended* pattern, because the alternative is a long-lived token in
 * `localStorage` where any injected script can read it — the refresh endpoint is
 * cookie-authenticated and is a CSRF target. An attacker cannot read the response,
 * but they can cause a rotation, which with reuse detection signs the victim out.
 *
 * So: **cookie-authenticated endpoints are protected, bearer endpoints are not**, and
 * the framework's recommendation is an access token in memory plus a refresh token in
 * an `HttpOnly` cookie with CSRF protection on the refresh endpoint. That is
 * `docs/session-security.md`, and it is why this file exists in a framework whose API
 * is mostly bearer-authenticated.
 *
 * The scheme is a signed double-submit token. A cookie holds the token, a header
 * repeats it, and the token is HMAC-bound to the session so a token minted for one
 * session cannot be replayed into another. Stateless — no server-side token store —
 * which matters because the alternative is a per-session write on every page load.
 */

export const CSRF_COOKIE_NAME = 'trustos_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Methods that cannot change state, and so need no protection. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export interface CsrfToken {
  /** Goes in a readable cookie and in the header. */
  token: string;
}

/**
 * Issues a token bound to a session.
 *
 * `<random>.<hmac(random, sessionId)>`. The random half makes it unguessable; the
 * signature makes it unusable in another session and unforgeable without the secret.
 * A plain random double-submit token — no signature — is defeated by any attacker who
 * can set a cookie on a sibling subdomain, which is a lower bar than it sounds.
 */
export function issueCsrfToken(sessionId: string, secret: string): CsrfToken {
  const nonce = randomBytes(24).toString('base64url');
  return { token: `${nonce}.${sign(nonce, sessionId, secret)}` };
}

/** Verifies a token against the session it should be bound to. */
export function verifyCsrfToken(token: string, sessionId: string, secret: string): boolean {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const nonce = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expected = sign(nonce, sessionId, secret);

  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);

  if (provided.length !== computed.length) return false;
  return timingSafeEqual(provided, computed);
}

function sign(nonce: string, sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${nonce}.${sessionId}`).digest('base64url');
}

export interface CsrfCheckRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed cookies, if the application parses them. */
  cookies?: Record<string, string | undefined>;
  /** Session the request is authenticated as, when it is cookie-authenticated. */
  sessionId: string | null;
  /** True when this request was authenticated by a cookie rather than a header. */
  cookieAuthenticated: boolean;
}

export interface CsrfDecision {
  ok: boolean;
  reason: string;
}

export interface CsrfOptions {
  secret: string;
  /** Origins permitted to make state-changing cookie requests. */
  allowedOrigins: string[];
  cookieName?: string;
  headerName?: string;
}

/**
 * Checks a request.
 *
 * Two independent checks, and both have to pass:
 *
 *   1. **Origin or Referer.** A cheap, strong signal: a cross-site POST carries the
 *      attacker's origin, and no attacker can change it. Not sufficient alone —
 *      some clients omit both — which is why it is not the only check.
 *   2. **Signed double-submit token.** Cookie and header must match, and the token
 *      must be bound to this session.
 *
 * A bearer-authenticated request skips both, for the reason at the top of the file.
 */
export function checkCsrf(request: CsrfCheckRequest, options: CsrfOptions): CsrfDecision {
  if (isSafeMethod(request.method)) return { ok: true, reason: 'safe_method' };

  // Not cookie-authenticated: a cross-site page cannot set the Authorization
  // header, so there is nothing to forge.
  if (!request.cookieAuthenticated) return { ok: true, reason: 'bearer_authenticated' };

  const origin = readHeader(request.headers, 'origin');
  const referer = readHeader(request.headers, 'referer');
  const source = origin ?? (referer ? originOf(referer) : null);

  if (!source) {
    // No origin and no referer on a state-changing cookie request. Refused rather
    // than trusted: the header is present on every browser request that matters, so
    // its absence is either a non-browser client (which should use a bearer token)
    // or something stripping it.
    return { ok: false, reason: 'missing_origin_and_referer' };
  }

  if (!options.allowedOrigins.includes(source)) {
    return { ok: false, reason: 'origin_not_allowlisted' };
  }

  const cookie = request.cookies?.[options.cookieName ?? CSRF_COOKIE_NAME];
  const header = readHeader(request.headers, options.headerName ?? CSRF_HEADER_NAME);

  if (!cookie || !header) return { ok: false, reason: 'csrf_token_missing' };
  if (!constantTimeEquals(cookie, header)) return { ok: false, reason: 'csrf_token_mismatch' };

  if (!request.sessionId) return { ok: false, reason: 'no_session_to_bind_to' };
  if (!verifyCsrfToken(header, request.sessionId, options.secret)) {
    // The token is well-formed but was minted for a different session — a replay.
    return { ok: false, reason: 'csrf_token_not_bound_to_session' };
  }

  return { ok: true, reason: 'csrf_token_valid' };
}

/** Throws unless the request passes. */
export function assertCsrf(request: CsrfCheckRequest, options: CsrfOptions): void {
  const decision = checkCsrf(request, options);
  if (decision.ok) return;

  throw ApiError.forbidden('This request could not be verified. Reload the page and try again.', {
    reason: `csrf_${decision.reason}`,
  });
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
