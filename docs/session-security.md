# Session security

Short-lived access tokens, rotating refresh tokens, and detection for the one case a
lifetime cannot protect against.

- [The two tokens](#the-two-tokens)
- [Rotation and reuse detection](#rotation-and-reuse-detection)
- [Four limits](#four-limits)
- [Device listing and revocation](#device-listing-and-revocation)
- [Suspicious activity](#suspicious-activity)
- [HTTP security headers](#http-security-headers)
- [CORS](#cors)
- [Cookies](#cookies)
- [CSRF](#csrf)
- [Rate limiting](#rate-limiting)
- [Configuration](#configuration)

---

## The two tokens

**Access token** — 15 minutes by default, 60 minutes maximum. It carries a resolved
permission set and **cannot be revoked before it expires**, which is exactly why it is
short: the lifetime is the window during which a revoked permission still works.

**Refresh token** — 30 days by default, 90 maximum. Single use. Exchanged for a new pair
and immediately marked used.

**Neither is stored.** The database holds SHA-256 of the refresh token; the access token
is not stored at all. A database leak yields no live session.

## Rotation and reuse detection

Every refresh mints a new refresh token and marks the presented one used. Both belong to
a _family_ — the chain descending from one login.

If an **already-used** token is presented again, the entire family is revoked, the
session ends, and `session.refresh_reuse_detected` is emitted at **critical** severity.

This is the only signal the framework has that a refresh token was stolen. If an
attacker copies a token, one of the two parties refreshes first; the other then presents
a used token, and that presentation is the detection. Without it, a stolen refresh token
is a session that lasts as long as the attacker keeps refreshing it — which is
indefinitely.

Two consequences that look like details and are not:

- **`usedAt` and `revokedAt` are separate columns.** A used token means "somebody has a
  copy" and the response is to kill the family. A revoked token means "already dealt
  with". Collapsing them turns a theft into an ordinary rejection and leaves the
  thief's session alive. The check order — revoked first, then used — depends on this.
- **`rotateRefreshTokens` is typed `z.literal(true)`.** It cannot be configured off.
  A deployment that turned it off to fix a client bug would silently lose the only
  theft detection in the system.

The store's `markRefreshTokenUsed` updates conditionally on `usedAt: null`, so two
concurrent refreshes with the same token produce one winner and one reuse detection
rather than two successes.

## Four limits

| Limit                   | Default       | What it is for                                      |
| ----------------------- | ------------- | --------------------------------------------------- |
| Idle timeout            | 30 min        | An unattended machine                               |
| Absolute lifetime       | 30 days       | A session that never ends is a permanent credential |
| Max concurrent sessions | 10            | Bounds credential sharing; evicts the **oldest**    |
| Rotation                | every refresh | See above                                           |

Concurrency eviction takes the oldest session, not the newest. Evicting the newest would
sign out the person who just logged in, which is both wrong and confusing.

The policy schema refuses idle > absolute, and access-token lifetime > refresh-token
lifetime. Both are configurations that boot and are wrong.

## Device listing and revocation

```
GET    /security/sessions/mine        my devices
DELETE /security/sessions/mine/:id    sign one out
DELETE /security/sessions/mine        sign out everywhere
GET    /security/sessions?userId=…    an administrator's view
DELETE /security/sessions/:id         an administrator's revocation
```

A device list is a security feature only if the person reading it can act on it, so
listing and revoking sit together.

`describeDevice` produces a coarse label — "Chrome on macOS", not a fingerprint.
Enough for a person to recognise their own laptop, not enough to build a tracking
identifier out of. IP addresses are stored as `correlationHash(address, salt)`: two
sessions from the same address are comparable, and the address itself is not in the
table.

The self-service routes verify ownership rather than trusting the path parameter —
without that check, `DELETE /security/sessions/mine/:id` is "revoke any session by id"
for every authenticated user. The administrative routes take the organization from the
caller's token and pass it as a filter, so learning another organization's user id buys
nothing. Both return `404` rather than `403` for something outside the caller's scope: a
403 confirms the session exists.

## Suspicious activity

`SessionService` calls an optional `onSuspicious` hook for: refresh reuse, a refresh
against a revoked family, and a session used from a different address hash than the one
it started from.

The hook is where a deployment puts step-up authentication, a notification, or an
automatic revocation. The framework does none of those, because "suspicious" is
product-specific — an address change is routine for a mobile user on a train and
alarming for a back-office terminal.

## HTTP security headers

Hand-written rather than `helmet`, because helmet's defaults change on a minor bump and
this framework's headers are part of its security contract. `securityHeaders()`:

| Header                         | Value                                 | Why                                                                      |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------ |
| `Content-Security-Policy`      | from `default-src 'none'`             | Deny-by-default, then add                                                |
| `X-Content-Type-Options`       | `nosniff`                             | Stops a JSON response being executed as script                           |
| `Referrer-Policy`              | `strict-origin-when-cross-origin`     | Keeps ids and tokens out of `Referer`                                    |
| `Permissions-Policy`           | camera, microphone, geolocation off   | Nothing here needs them                                                  |
| `X-Frame-Options`              | `DENY`                                | Clickjacking                                                             |
| `Cross-Origin-Opener-Policy`   | `same-origin`                         | A window reference cannot reach in                                       |
| `Cross-Origin-Resource-Policy` | `same-origin`                         |                                                                          |
| `Cache-Control`                | `no-store`                            | An authenticated response cached for the next person on a shared machine |
| `Strict-Transport-Security`    | `max-age=31536000; includeSubDomains` | **Production only**                                                      |

HSTS is production-only and HTTPS-only. Sent in development it pins `localhost` to
https in the developer's browser, which is a confusing half-day.

The middleware runs **first**, so the headers are present on 404s and error responses —
the responses a misconfigured client is most likely to see. `/docs` is the one relaxed
path, because Swagger UI needs inline styles, and it is disabled in production anyway.

## CORS

`evaluateCors` matches the origin **exactly** against the configured list. It never
reflects `Origin` back, and it refuses `*` outright when credentials are enabled.

`productionPolicyProblems` refuses a wildcard origin and a plain-`http` origin in
production, so the check is at startup and not at the first cross-origin request.

## Cookies

`buildCookie` sets `HttpOnly`, `Secure` (production), `SameSite=Lax` and a `Path`. It
**refuses to build a cookie with `SameSite=None` without `Secure`** — a combination
browsers reject anyway, but failing at construction gives a clear error instead of a
silently missing cookie.

`SameSite=Lax` rather than `Strict`: `Strict` breaks the OIDC redirect back from the
identity provider, because the cookie is not sent on a cross-site navigation. `Lax`
sends it on a top-level GET, which is what a redirect is.

## CSRF

**A bearer-token API needs no CSRF protection**, and it is worth being precise about
why: CSRF works because the browser attaches credentials automatically. An
`Authorization` header is not attached automatically — an attacker's page cannot add it,
because reading the token requires same-origin script access.

**Where that stops being true:** the refresh endpoint, if the refresh token is in a
cookie. That cookie _is_ sent automatically, so a forged POST to `/auth/refresh` can
mint a session. Any cookie-authenticated route needs the protection.

`checkCsrf` implements a signed double-submit token, HMAC-bound to the session so a
token from one session cannot be replayed in another, plus an `Origin`/`Referer` check.
Both, because the header check fails on a request with neither and the token check fails
if a subdomain can set cookies.

`http.csrfEnabled` defaults true and `productionPolicyProblems` refuses it off in
production.

## Rate limiting

Fixed-window: one integer per key per window. `InMemoryRateLimiter` sweeps expired
entries on `consume` rather than on a timer, so an idle process holds no interval.

`enforceRateLimit` throws `ApiError.rateLimited` with `retryAfterSeconds`, and
`rateLimitHeaders` produces `X-RateLimit-*` plus `Retry-After`.

Defaults: 5 login attempts / 15 min per identifier, 60 refreshes / hour, 10 API key
operations / hour.

**It is process-local**, stated rather than hidden: N instances give an attacker N times
the budget. The `RateLimiter` interface is the seam for a shared store; this phase adds
no Redis. In the meantime, a platform-level limit at the edge is the right complement.

## Configuration

| Variable                            | Default                       |
| ----------------------------------- | ----------------------------- |
| `SECURITY_ACCESS_TOKEN_SECONDS`     | 900                           |
| `SECURITY_REFRESH_TOKEN_SECONDS`    | 2592000                       |
| `SECURITY_SESSION_IDLE_SECONDS`     | 1800                          |
| `SECURITY_SESSION_ABSOLUTE_SECONDS` | 2592000                       |
| `SECURITY_MAX_CONCURRENT_SESSIONS`  | 10                            |
| `SECURITY_HSTS_ENABLED`             | true in production            |
| `SECURITY_CSRF_ENABLED`             | true                          |
| `CORS_ORIGINS`                      | — (`*` refused in production) |

---

**See also:** [enterprise-identity.md](enterprise-identity.md) ·
[incident-response.md](incident-response.md) ·
[threat-model.md](threat-model.md) ·
[security-testing.md](security-testing.md)
