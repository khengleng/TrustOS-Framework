# TrustOS v0.1 — functional validation report

2026-08-29. Reproduce with `npm run validate`; add `--deployed --base-url <url>` for the
deployment checks. Machine-readable results in `docs/validation/latest.json`.

## Executive scorecard

| Capability              | Status              | Security | Railway DEV   |
| ----------------------- | ------------------- | -------- | ------------- |
| Identity                | PASS                | PASS     | PASS          |
| Multi-tenancy           | PASS                | PASS     | not exercised |
| RBAC                    | PASS                | PASS     | not exercised |
| Workflow                | PASS                | PASS     | not deployed  |
| Maker-checker           | PASS                | PASS     | not deployed  |
| Audit                   | PASS                | PASS     | not exercised |
| Policy                  | PASS                | PASS     | not deployed  |
| Case management         | PARTIAL             | PASS     | not deployed  |
| Approval Workbench      | **NOT_IMPLEMENTED** | —        | —             |
| AI Gateway              | PASS                | PASS     | not deployed  |
| Financial primitives    | PASS                | PASS     | not deployed  |
| Financial product layer | PASS                | PASS     | not deployed  |
| API management          | PASS                | PASS     | not deployed  |
| Data governance         | PASS                | PASS     | not deployed  |
| Observability           | PARTIAL             | PASS     | PASS          |
| Health / readiness      | PASS                | PASS     | PASS          |
| Backup                  | PARTIAL             | —        | not exercised |
| Restore                 | PARTIAL             | —        | not exercised |
| Security controls       | PASS                | PASS     | PASS          |

"Not exercised" means the capability is proven by test but was not driven end-to-end through
the deployment. "Not deployed" means no deployed service exposes it over HTTP.

## Evidence by capability

### Identity — PASS

57 tests. OIDC token validation checks signature, issuer, audience **and** authorized party;
a token minted for another client is refused. Verified against the live deployment: a forged
bearer token returns 401, and an anonymous request to a protected route returns 401.

Multi-factor is enforced and was proven end to end in a browser: the assurance guard refuses
a privileged role whose token presents no second factor, and accepts one whose `acr` reports
the step-up. The refusal path records what the token actually presented
(`presentedLevel`, `presentedMethods`, `presentedAcr`).

### Multi-tenancy — PASS (critical)

34 tests in the package, **37 spec files across the repository assert tenant isolation**.
`scopedDelegate` rewrites `findUnique` into a scoped `findFirst` and throws on any operation
it cannot scope. The pilot application's security suite proves, at the service layer:

- a merchant, wallet and journal read from another organization is refused
- a platform-wide role does not cross an organization boundary
- a cross-tenant read answers `not_found`, never `forbidden` — so an id endpoint cannot be
  used as an oracle
- a merchant id alone is not accepted as authorization
- a payment cannot name a merchant in another tenant
- one tenant cannot replay another's idempotency reference

### RBAC — PASS (critical)

26 tests, plus role-matrix assertions in the pilot: the auditor holds no write permission,
the cashier holds no settlement, ledger or limit access, and every role's declared capability
is matched against what it actually holds. A read scope does not satisfy a write requirement,
and a scope on one resource does not reach another.

### Workflow and maker-checker — PASS

165 and 64 tests. Separation of duty is enforced server-side: the verifier cannot approve
their own work, the requester cannot approve their own limit change, and **no role may hold
both halves of a maker-checker pair** — with a test that deliberately constructs a role
holding both to prove the check catches it.

### Audit — PASS (critical)

Every consequential action is recorded with actor, organization, correlation id and outcome.
Records are scoped to their organization, the service exposes no way to delete one, and the
posted journal has no update path. Amounts and balances are kept out of merchant audit
metadata.

### Financial primitives — PASS (critical)

184 tests. An unbalanced journal is refused; a refused payment posts no journal; wallet
balance equals the sum of journals; a repeated reference does not charge twice, and
concurrent duplicates do not both execute.

### Case management — PARTIAL

33 tests over a 3-file domain package. Create, assign, status and history exist as a library.
No deployed service exposes it, and the "Case Management" console is a descriptor with no
runtime. Classified PARTIAL rather than PASS for that reason.

### Approval Workbench — NOT_IMPLEMENTED

A console descriptor only. There is no queue, no request detail, no approve/reject/rework
path and no service behind it. The underlying maker-checker engine is implemented and tested;
the workbench that would drive it is not. Section 12 of the validation brief asked that it
operate against the real engine — doing so would be building an application, which this task
excludes, so it is reported rather than built.

### Observability — PARTIAL

Structured logs, request ids and correlation ids are present and verified in the deployment's
own logs. `/health` and `/ready` answer and `/ready` performs a real database check. There is
no metrics backend, no latency histogram and no dependency-health dashboard behind the SRE
console — the console is a descriptor.

### Backup and restore — PARTIAL

40 tests across the two packages. A real restore was exercised during the pilot and is
recorded in `docs/pilot/evidence/`. No backup or restore was performed against Railway DEV in
this validation round, so both are PARTIAL rather than PASS. Marking them PASS on the strength
of unit tests would be exactly the error this exercise exists to avoid.

### Security controls — PASS (critical)

98 tests. Verified live on Railway DEV: HSTS, `nosniff`, `X-Frame-Options: DENY`, a
`default-src 'none'` content policy, no credential-shaped values in the health payload, an
unapproved CORS origin receiving no allow-origin header, and a spoofed `Host` never reaching
the application — Railway's edge answers first.

## Section 31 — the end-to-end smoke scenario

**Not executed as specified.** The brief asks for a live scenario: login → tenant → maker →
checker → self-approval denied → checker approves → audit → tenant B denied → health.

Every step of it is proven by test, in the pilot's suites, running the real engines. None of
it can currently be driven over HTTP against the deployment, for one reason: **no deployed
service exposes workflow, maker-checker or case management.** `governance-tool` serves
descriptors, and `trustos-api` is the reference example.

Reporting this as PASS on the strength of in-process tests would misrepresent what was
verified. It is recorded as the gap it is.

## Lifecycle promotion (section 33)

Evidence-based, and no application moved as a result of this validation.

| From          | To            | Requires                                                                          |
| ------------- | ------------- | --------------------------------------------------------------------------------- |
| `draft`       | `implemented` | something executes the descriptor — a service and a UI, not a declaration         |
| `implemented` | `validated`   | its functional and security tests pass, and tenant isolation is proven at the API |
| `validated`   | `active`      | deployed, probed live, and an owner accepts it                                    |

An application classified **critical** risk — Finance Operations, Platform Administration,
Risk & Compliance — needs the same evidence held to a higher standard, not a shortcut.
All eleven are `draft` with a validation status of `not_tested`, which the Governance
Tool now reports alongside lifecycle so that a console which renders cannot be mistaken
for one that works.

The per-application detail is in [`application-matrix.md`](application-matrix.md).

## Blocking issues

1. ~~**No `AccessResolver` implementation.**~~ **Fixed.** `@trustsystem/access-resolver` reads
   membership per request; 15 tests, each verified to fail when the behaviour it covers is
   removed.
2. ~~**No OIDC-subject-to-`User` link.**~~ **Schema fixed, provisioning outstanding.**
   `User.externalId` exists and the resolver matches on it, but nothing populates it yet —
   no user has one, so the resolver has nothing to match. Delegation below platform-root
   remains blocked until a provisioning path exists.
3. **The console applications have no runtime.** Eleven descriptors, no implementations.
4. **`trustos-api` runs the reference example** and is the last service on local identity.
5. **No live end-to-end path** for workflow, maker-checker or case management.

## Non-blocking, worth recording

- `TRUSTOS_ENVIRONMENT=dev` in the environment named `production`
- Dev and UAT have no identity provider, so neither can be signed into
- The running Keycloak realm has drifted from `docker/keycloak/realm-trustos.json`
  (`editUsernameAllowed`, SMTP, `acr.loa.map`, the `browser-mfa` flow were applied by API)
- With `browser-mfa` bound, OTP runs only for logins that request the assurance level

## Final decision

**B. TRUSTOS v0.1 PARTIALLY VALIDATED — REMEDIATE BEFORE PRODUCT PILOT**

The framework's engines are real and well tested. 5,663 tests pass across 193 packages, the
critical capabilities — identity, tenancy, RBAC, authorization, audit, financial integrity,
security controls — are implemented and exercised, and the deployed service enforces
authentication, tenant scoping, MFA and its security headers under live probing.

It is not ready for a product pilot, for two reasons that have nothing to do with test
counts. Authorization below platform-root does not work end to end, so no real team can be
given differentiated access. And the applications a pilot would use are declarations rather
than software.

The first is a bounded piece of work — a resolver and an identity link. The second is the
honest scope of building a product on the framework, which is what a pilot is.
