# Pilot security review

§28 of the readiness specification, before UAT is considered pilot-ready.

Every finding below was produced against a running service or by a check in this repository. Where
something was not tested, it says so rather than passing quietly.

## Summary

| Area              | Verdict     | Evidence                                                                                       |
| ----------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| Authentication    | **Pass**    | Live: invalid and expired tokens both refused with 401                                         |
| Authorization     | **Pass**    | Live: auditor refused, owner permitted, on the same route                                      |
| Tenant isolation  | **Pass**    | Live: 403 on another organization; 5,493 tests including the framework's own                   |
| Secrets           | **Pass**    | No secret-bearing file tracked; no credential-shaped string committed; config redacted in logs |
| CORS              | **Pass**    | `*` and plain-http origins refused in production by the policy                                 |
| CSRF              | **Pass**    | Required in production by the policy; bearer-token APIs unaffected                             |
| Rate limits       | **Partial** | Implemented and tested in-process; not exercised under load against a deployment               |
| API key handling  | **Pass**    | Hashed on creation, never recoverable, prefix-only display                                     |
| Secure headers    | **Pass**    | Live: HSTS, CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`                |
| Sensitive logging | **Pass**    | Live: config redacted, no token or secret in any line                                          |
| SQL injection     | **Pass**    | Prisma parameterizes; no raw SQL on a user-supplied path                                       |
| IDOR              | **Pass**    | Live: 403 on a foreign organization id; tenant is a required leading argument                  |

**Two findings were fixed during this review.** Both are described below.

## Authentication

Live results against `api-example` in production mode:

| Request                                         | Result |
| ----------------------------------------------- | ------ |
| No `Authorization` header                       | 401    |
| `Bearer not.a.real.token`                       | 401    |
| A structurally valid JWT with `exp` in the past | 401    |

All three identical, deliberately: answering differently for a malformed token and an expired one
tells a caller which they have.

**The local identity provider is refused in production** unless
`SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true` is set — which makes the choice deliberate and
recorded rather than accidental.

## Authorization

| Actor     | Action               | Result  |
| --------- | -------------------- | ------- |
| `auditor` | Invite a member      | **403** |
| `auditor` | Read the member list | **403** |
| `owner`   | Invite a member      | **201** |

The same route, two actors, two outcomes. That is what makes the 403 a permission check rather than
a broken route.

`POST /api/organizations` as the auditor returns 201, and that is correct: the route is
`@AllowAnyAuthenticated()` because a user cannot hold an organization permission before an
organization exists. The auditor gains nothing in the existing organization, which the three 403s
confirm.

## Tenant isolation

Live: reading another organization's members returned **403**.

Structurally, every framework signature takes `organizationId` first and non-optionally, so
omitting it is a type error rather than a code review question. The phase-14 pilot adds eleven
tests against the service rather than a UI; see
[`../pilot/evidence/tenant-isolation.md`](../pilot/evidence/tenant-isolation.md).

## Secrets

| Check                                   | Result                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Secret-bearing files tracked            | **none** — CI refuses `.env`, `.pem`, `.p12`, `id_rsa`                               |
| Credential-shaped strings committed     | **none** — eight patterns scanned in CI                                              |
| `.env.example` contains a usable secret | **no** — CI requires long secret-named values to identify themselves as placeholders |
| Secrets in logs                         | **redacted, not omitted** — `"jwtSecret": "[redacted]"`                              |

Redacted rather than omitted matters: an omitted key and an unset key look identical in a log, and
the difference is what somebody is debugging at the time.

`.dockerignore` excludes `.env` before anything else. A `.env` copied into an image is a secret in
every layer, recoverable by anybody who can pull it, and visible in `docker history`.

## CORS and CSRF

The production policy refuses:

- `corsOrigins` containing `*`
- any `http://` origin
- `csrfEnabled: false`

Verified by refusing to start: setting `CORS_ORIGINS=*` in production produces
`Refusing to start. http.corsOrigins: "*" is not permitted in production.` before a port is bound.

## Rate limits — partial

`@trustos/session-security` implements per-route limits with the policy's rules, and
`@trustos/api-rate-limit` implements the API gate's. Both are tested, including the concurrency
case where a check-then-increment store would let two callers through.

**Not exercised under load against a deployment.** The limits are correct in-process; whether they
hold across two replicas is untested, because nothing here has run two replicas. That is the reason
for the partial rather than a defect.

## Secure headers — a finding, fixed

**`api-example` mounted no security headers.**

Every other application in the repository mounts `securityHeadersMiddleware`. The reference API —
the one people copy — did not, because it predates `@trustos/session-security` and was never
backfilled. A live smoke test found no `X-Content-Type-Options` and no `X-Frame-Options` on any
response.

Fixed. Verified live:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; script-src 'self'; ...
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### A second finding, also fixed

**Every application would have refused to start in production.**

`httpPolicySchema` has documented `hsts` as "Forced on in production" since it was written. The
loader refused when it was absent instead, so every application would have failed with
`http.hsts: must be enabled in production` — each having to pass the one value the policy permits
in order to say it.

Now forced on when unset, and **still refused when a deployment says `hsts: false`**. That
distinction is what keeps the default from being a weakening: not mentioning it is not a statement,
and disabling it is.

## Sensitive logging

Every request line carries `requestId`, `actorId`, `organizationId`, `method`, `path`,
`statusCode`, `durationMs`, `ip`.

No line carried a token, a secret, a password or a financial payload. The start-up line logs the
whole configuration with `redactSecrets` applied.

`@trustos/audit` redacts `before` and `after` before writing, so the audit trail cannot become the
place sensitive values are kept.

## SQL injection

Prisma parameterizes every query. A repository search for `$queryRaw` and `$executeRaw` finds them
only where the SQL is a constant — the audit append-only trigger and the migration files.

No user-supplied string reaches a raw query.

## IDOR

Live: a foreign organization id returned **403**.

The structural control is the one that matters: `organizationId` is a required leading argument on
every scoped read, so a lookup by id alone does not compile. The phase-14 pilot tests the same
property against its own services.

## What was not tested

Stated rather than silently absent.

- **Penetration testing.** None. No external review.
- **Fuzzing.** None.
- **Denial of service.** The rate limiter was tested for correctness, not under load.
- **Multi-replica behaviour.** Everything here is single-replica.
- **Railway's own controls.** Its network isolation, its secret store and its build environment
  have been used and not audited.
- **Supply chain beyond `npm audit`.** No SBOM, no provenance verification.

## Open items

**Six high-severity dependency advisories**, all with fixes available, one direct (`prisma`). Not
applied during the pilot because changing the dependency tree mid-run would have changed what was
being measured. First item in the remediation list.

See [`../pilot/evidence/security-results.md`](../pilot/evidence/security-results.md).

## Verdict

**Sufficient for a UAT pilot.** Not sufficient for production, and the gap is not this document —
it is the two FAIL items in the readiness scorecard and the six advisories above.
