# Threat model

Fifteen threats the identity and access layer is built against. For each: what it is,
what it reaches, what stops it, what remains, and what would close the gap.

Residual risk is stated honestly. A threat model that claims every risk is fully
mitigated is a marketing document.

---

## 1. Stolen access token

**Assets:** every record the token's permissions reach, within its organization.

**Controls.** 15-minute default lifetime, 60-minute ceiling enforced by policy;
signature, issuer and audience validated on every request; `jti` recorded for
correlation; permissions resolved server-side, so a token cannot claim more than its
holder has.

**Residual risk.** An access token cannot be revoked before it expires. A stolen token
works for up to its remaining lifetime, and revoking the user's session does not stop
it. This is inherent to stateless tokens: the alternative is a database lookup per
request, which is a different system.

**Future control.** A revocation list for `jti`, checked from a short-TTL cache — costs
a lookup, buys immediate revocation. Or shorter lifetimes (5 minutes) at the cost of
more refresh traffic.

---

## 2. Stolen refresh token

**Assets:** an indefinite session — every access token the thief cares to mint.

**Controls.** Single use with rotation on every refresh; family-wide revocation on reuse
detection; `session.refresh_reuse_detected` at critical severity; SHA-256 storage, so a
database leak yields nothing; bounded lifetime.

**Residual risk.** Detection is _retrospective_. It fires when the second party
refreshes, which may be hours later. In that window the thief has a working session. And
the response — killing the family — signs out the legitimate user too, so the victim
experiences the theft as a logout.

**Future control.** Sender-constrained tokens (DPoP or mTLS) bind a refresh token to a
key the client holds, so a copied token is useless. That is the real fix and it requires
client support.

---

## 3. Credential stuffing

**Assets:** any account whose password appears in a breach corpus.

**Controls.** Lockout after N failures within a window; rate limiting per identifier;
compromised-password check at registration and change; identical responses and identical
timing for every failure mode.

**Residual risk.** Both the lockout counter and the rate limiter are **process-local**.
N instances behind a load balancer give an attacker N times the attempts. A distributed
attack from many addresses against many accounts — low velocity per account — stays
under both thresholds. The shipped compromised-password list is small.

**Future control.** A shared `LockoutStore` and `RateLimiter` (the ports exist); a real
breach corpus behind `CompromisedPasswordChecker`; per-address as well as per-identifier
limits.

---

## 4. Cross-tenant data access

**Assets:** every other organization's data. The worst outcome in a multi-tenant system.

**Controls.** The organization is never read from a client-supplied value; membership is
re-resolved per request; `tenantMembershipPolicy` and `tenantResourceOwnershipPolicy`;
`assertTenantMatch` at the data layer; `scopedDelegate` for tenant-scoped queries;
`authz.cross_tenant_blocked` at critical severity. Explicit negative tests for header
manipulation, valid-token-wrong-org, and inactive membership.

**Residual risk.** A hand-written raw SQL query bypasses `scopedDelegate` entirely. So
does a Prisma query written against the unscoped client. The framework cannot prevent
this; it can only make the scoped path the easy one.

**Future control.** Postgres row-level security, so the boundary is enforced by the
database rather than by the application remembering to. A lint rule against `$queryRaw`
outside an allow-list.

---

## 5. Privilege escalation via role assignment

**Assets:** organization ownership, and through it everything in the organization.

**Controls.** `grantableRoles` per role, enforced by `canGrantRole` and
`roleGrantPolicy`; `administrator` explicitly cannot grant `administrator` or
`organization_owner`; `authz.role_escalation_blocked` at critical severity; audit
records with before and after.

**Residual risk.** A product that defines custom roles defines its own grant matrix, and
nothing checks that the matrix is acyclic or that a custom role is not transitively able
to grant something above itself. `super_admin` holds the wildcard and can grant
anything, by design.

**Future control.** Static validation of the grant graph at startup — refuse a matrix
where role A can grant role B which can grant A.

---

## 6. API key leakage

**Assets:** everything the key's scopes reach, for as long as it is valid.

**Controls.** Hashed storage — a database leak yields no usable key; recognisable `tos_`
prefix so a secret scanner catches it in a commit; scopes limiting reach; optional IP
allowlist; expiry; `lastUsedAt`/`lastUsedIp` for investigation; rotation with a grace
period; secret scanning in CI.

**Residual risk.** A key in a customer's committed configuration file, in a CI log, or
in a support ticket screenshot is outside the framework's reach. The 24-hour rotation
grace period is 24 hours during which the old key still works.

**Future control.** Automatic revocation on a GitHub secret-scanning webhook; anomaly
detection on `lastUsedIp`; short-lived tokens exchanged from the key, so the long-lived
credential is never on the wire.

---

## 7. Token forgery

**Assets:** any identity the attacker cares to assert.

**Controls.** Signature verification against the issuer's JWKS; **algorithm pinning**
that excludes `none` and every HMAC variant; exact `iss` match; `aud` and `azp`
validation; small clock skew; 26 negative tests covering each of these.

The HMAC exclusion is not theoretical: an attacker who can set `alg: HS256` on an
RS256-configured verifier can sign a token using the _public_ key as the HMAC secret.
Pinning the algorithm list is what prevents it.

**Residual risk.** A compromised issuer signing key forges anything, and the framework
cannot detect it — it is trusting the issuer by design. JWKS is fetched over HTTPS, so
its integrity depends on TLS and on the issuer's own security.

**Future control.** Certificate pinning on the JWKS endpoint; monitoring for unexpected
`kid` values; a second issuer for critical operations.

---

## 8. Session fixation

**Assets:** the victim's session, if an attacker can plant a session identifier before
login.

**Controls.** A new session id and a new refresh family are created on every successful
authentication — nothing pre-login is carried forward. Sessions are keyed by
server-generated ids, never by a client-supplied value.

**Residual risk.** Low. The main remaining variant needs a subdomain that can set
cookies on the parent domain, which is a cookie-scoping problem rather than a session
one.

**Future control.** `__Host-` cookie prefixes, which browsers refuse to accept from a
subdomain.

---

## 9. CSRF on cookie-authenticated routes

**Assets:** any state-changing operation on a cookie-authenticated route — in this
framework, primarily refresh.

**Controls.** Bearer-token routes need none, because an `Authorization` header is not
attached automatically. For cookie routes: a signed double-submit token HMAC-bound to
the session, plus an `Origin`/`Referer` check; `SameSite=Lax` cookies; CSRF cannot be
disabled in production.

**Residual risk.** A cookie-authenticated route added later without the check. Nothing
enforces the pairing automatically.

**Future control.** A guard that refuses any non-safe method on a route that reads a
cookie without a CSRF check declared.

---

## 10. Enumeration of accounts, keys or organizations

**Assets:** a list of valid email addresses, which is the input to threat 3, plus
organizational structure.

**Controls.** Identical error message, error code and HTTP status for every
authentication failure — asserted by a test that the set of distinct messages has size
one. A dummy hash verification on a user miss, so timing matches. `404` rather than
`403` for a resource outside the caller's scope, so the response does not confirm
existence. `assertNoLeakedValues` on denial responses.

**Residual risk.** Registration and password reset are inherently closer to disclosure —
a reset flow that says "if an account exists, we sent an email" is correct, but a
sufficiently precise timing measurement may still distinguish the branches. Response
timing is matched, not constant.

**Future control.** Constant-time responses on the reset path; rate limiting on
registration.

---

## 11. Service-account abuse

**Assets:** whatever the integration reaches — often a great deal, since batch jobs touch
many records.

**Controls.** A distinct actor type, so audit records name the machine; interactive
routes refused; `isSuperAdmin` forced false with no configuration to change it; scopes
and roles; optional expiry; `lastUsedAt` for finding accounts nobody uses; disable rather
than delete, so audit records stay resolvable.

**Residual risk.** A service-account credential in an environment variable is readable by
anyone who can read the environment — which includes anyone who can exec into the
container. Rotation has no grace period, so a rotation performed at the wrong moment
breaks a running job.

**Future control.** OIDC client-credentials mode (already supported and recommended)
removes the stored secret entirely; workload identity removes the credential.

---

## 12. Secret exposure in logs, errors or configuration

**Assets:** any credential the application handles.

**Controls.** `redactSecrets` by field name, applied in the logger and in the security
event emitter; `.env.example` contains placeholders only, and the config loader rejects
those placeholder values in production; configuration errors report a field name and a
length, never a value; the policy summary enumerates safe fields rather than removing
unsafe ones; `assertNoLeakedValues` in tests; secret scanning in CI.

**Residual risk.** Name-based redaction misses a secret in a field named `data`,
`payload` or `body`. A third-party library that logs its own request bodies is outside
the redactor entirely.

**Future control.** A branded `Secret<T>` type whose `toString` and `toJSON` return
`[REDACTED]`, so a secret cannot be serialized by accident regardless of the field name.

---

## 13. Authorization bypass through a misconfigured route

**Assets:** whatever the unguarded route exposes.

**Controls.** Default deny: a route declaring no permission requirement is refused, not
allowed. Nine ordered policies, only the last of which can allow. Guard order asserted by
a boot test. `@Public()` is explicit and greppable.

**Residual risk.** `@Public()` applied to a route that handles real data. That is a
one-line change that passes review if nobody looks, and no automated check can tell a
genuinely public health endpoint from a mistake.

**Future control.** A CI check that the set of `@Public()` routes matches a committed
allow-list, so adding one is a reviewed diff.

---

## 14. Insecure production configuration

**Assets:** everything. A five-hour access token or a wildcard CORS origin undermines
several controls at once.

**Controls.** `loadSecurityPolicy` refuses to start on: the local provider in production
without an explicit opt-in; both providers together; a non-https OIDC issuer; a missing
issuer, audience or client id; an access token over 30 minutes; a session over 30 days; a
weak, placeholder or shared JWT secret; a wildcard or plain-http CORS origin; HSTS off;
CSRF off. Cross-field checks refuse idle > absolute and access > refresh. Problems are
reported as a list, with lengths but never values.

**Residual risk.** The check runs at startup, so a configuration changed at runtime is
not re-validated. Settings outside the policy — Keycloak's own token lifetimes, the
platform's TLS configuration — are not checked at all.

**Future control.** A `trustos doctor --production` command that validates a deployed
environment; a periodic re-validation that alerts on drift.

---

## 15. Insider access to the security portal

**Assets:** every credential and session in the organization. The portal is a
concentration of authority by nature.

**Controls.** Per-operation permissions, split read from write: `administrator` can
revoke but not create; `auditor` can only read. No route returns a plaintext credential,
a token value or a secret configuration value — asserted by a test that no `GET` route
over credentials exists beyond metadata and usage. Every operation is audited with the
actor. `@RequireAuthenticationLevel('high')` on the policy summary. `@HumanActorsOnly()`
throughout, so no machine can administer credentials.

**Residual risk.** An `organization_owner` can create a key with any scope and use it.
That is the definition of the role, and the control is detective rather than preventive:
the audit trail says who did it. Nothing here prevents a legitimate administrator from
abusing legitimate authority.

**Future control.** Two-person approval for credential creation; anomaly detection on
administrative volume; time-bound elevation so ownership is claimed for an hour rather
than held permanently.

---

## What is out of scope

Application-layer denial of service; supply-chain compromise of npm packages beyond
`npm audit` and lockfile validation; physical access; compromise of the identity
provider itself; the platform's own network security. Each needs controls that live
below or beside this framework.

---

**See also:** [enterprise-identity.md](enterprise-identity.md) ·
[authorization-model.md](authorization-model.md) ·
[session-security.md](session-security.md) ·
[api-key-security.md](api-key-security.md) ·
[incident-response.md](incident-response.md) ·
[security-testing.md](security-testing.md)
