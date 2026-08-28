# Pilot readiness scorecard

Eighteen categories. **PASS requires evidence**, and a category with no evidence is FAIL rather
than PARTIAL.

## The scorecard

| #   | Category           | Score          | Evidence                                                                                                                 |
| --- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Build              | **PASS**       | `npm run build` clean; `tsc -b` across 171 packages and 11 apps                                                          |
| 2   | Tests              | **PASS**       | 5,493 tests across 225 files, all passing                                                                                |
| 3   | Security           | **PARTIAL**    | [`../security/pilot-security-review.md`](../security/pilot-security-review.md) — 6 advisories open, all with fixes       |
| 4   | Identity           | **PARTIAL**    | Local provider verified live; OIDC configured and not exercised                                                          |
| 5   | RBAC               | **PASS**       | Live: auditor 403, owner 201, same route                                                                                 |
| 6   | Tenant isolation   | **PASS**       | Live: 403 on a foreign organization; 11 pilot tests against services                                                     |
| 7   | Audit              | **PASS**       | Append-only trigger verified **after a restore** — see below                                                             |
| 8   | Workflow           | **PASS**       | Framework suite; the pilot's maker-checker in [`../pilot/evidence/maker-checker.md`](../pilot/evidence/maker-checker.md) |
| 9   | Policy             | **PASS**       | Live ALLOW and DENY, both recorded with the policy version                                                               |
| 10  | Database migration | **PASS**       | 9 migrations applied clean; safety gate in CI, both paths verified                                                       |
| 11  | Health             | **PASS**       | Live: `/health` 200 and `/ready` 503 with the database stopped                                                           |
| 12  | Observability      | **PARTIAL**    | Structured logs with correlation ids verified live; no metrics backend                                                   |
| 13  | Backup             | **PASS**       | [`evidence/restore-test.md`](evidence/restore-test.md) — taken, restored, validated                                      |
| 14  | Restore            | **PASS**       | Performed. Schema, data, migration history and append-only all intact                                                    |
| 15  | DEV deployment     | **PARTIAL**    | A live deployment exists and is healthy. It runs **pre-fix code** and fails two security checks — see below              |
| 16  | UAT deployment     | **UNVERIFIED** | No `trustos-uat` project is linked. Whether one exists could not be checked                                              |
| 17  | Smoke tests        | **PASS**       | 10 passed, 0 failed, 1 skipped, against a live service                                                                   |
| 18  | Documentation      | **PASS**       | This directory, plus the release and security documents                                                                  |

**13 PASS · 4 PARTIAL · 1 FAIL**

## The live deployment

Inspected 2026-08-27 after authenticating the Railway CLI.

|                 |                                                                                  |
| --------------- | -------------------------------------------------------------------------------- |
| Project         | `TrustOS-Framework` (`cc96d5fe-…`)                                               |
| Environments    | **one**, named `production` — no `dev`, no `uat`                                 |
| Services        | **two**: `Postgres` and `trustos-api`                                            |
| Domain          | `https://trustos-api-production.up.railway.app`                                  |
| Last deployment | **2026-08-12**, SUCCESS — around commit `a41916e`, before any of phases 11–15    |
| Uptime          | ~14.9 days                                                                       |
| Builder         | Railpack with `RAILPACK_*` commands — **not** the `Dockerfile` added in phase 15 |

**It is healthy.** `/health` returns 200 and `/ready` returns 200 with the database answering in
129ms. The health/readiness split works in production.

### Smoke results against it

**5 passed, 1 failed, 5 skipped** —
[`evidence/smoke-report-live-production.json`](evidence/smoke-report-live-production.json).

The five skips are login and everything behind it: no smoke credentials exist in that environment.

### Two findings

**1. All five security headers are missing.** Verified against the live domain:

```text
MISSING  x-content-type-options
MISSING  x-frame-options
MISSING  content-security-policy
MISSING  referrer-policy
MISSING  strict-transport-security
```

This is the defect found and fixed during phase 15 — `api-example` never mounted
`securityHeadersMiddleware`. **The fix is committed and not deployed**, because the running code
predates it by two weeks.

**2. Swagger is publicly exposed.** `OPENAPI_ENABLED=true` in production, so `/docs` serves the UI
and `/docs-json` serves the full specification — **15 endpoints listed publicly**, including
`/api/auth/register`, `/api/auth/login` and `/api/auth/refresh`.

That is a deliberate default for development and the wrong one here: it hands an attacker the API
surface without them having to guess it.

### Deploying the fix requires a variable change first

The service would **refuse to start** on current variables. `IDENTITY_PROVIDER` is unset, so the
post-fix `api-example` loads the security policy with the local provider in production:

```text
Refusing to start.
  - allowedIdentityProviders: the local provider is intended for development, tests and
    lightweight deployments. Set IDENTITY_PROVIDER=oidc, or accept this explicitly with
    SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true.
```

That refusal is the policy working. It also means a deploy without the variable change is an
outage, so the order matters:

```bash
# 1. Variables first, or the new build will not boot.
railway variables --service trustos-api   --set "SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true"   --set "TRUSTOS_ENVIRONMENT=dev"   --set "OPENAPI_ENABLED=false"   --set "CORS_ORIGINS=https://<the console origin>"

# 2. Then deploy.
railway up --service trustos-api

# 3. Then re-run the smoke tests against the domain.
TRUSTOS_BASE_URL=https://trustos-api-production.up.railway.app npm run smoke
```

`SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true` is the pilot answer, not the production one.
Configuring OIDC is the production answer and moves Identity off PARTIAL.

### Why this is PARTIAL and not PASS

A deployment exists, is healthy, and has been serving for two weeks — that is real, and more than
the earlier draft of this document credited.

It also runs code two weeks old, fails a security check, and exposes its own API surface. Scoring
that PASS would mean scoring a deployment on the fact of its existence rather than on what it does.

### Why UAT is FAIL

There is one environment and it is named `production`. No `trustos-uat` exists, so nothing about
environment separation has been demonstrated — and the environment that does exist is named for the
one this pilot explicitly does not authorise.

## Why each score

### 1. Build — PASS

`npm ci` from a clean checkout, `npm run build` clean. TypeScript project references across 171
packages and 11 applications. `npx trustos architecture-check` clean across 973 files:
declared-dependencies-only, no deep imports, layering respected.

### 2. Tests — PASS

**5,493 tests across 225 files, all passing.** Lint clean (0 errors). Format clean.

### 3. Security — PARTIAL

Everything in the security review passes, and **two findings were fixed during it**: `api-example`
mounted no security headers, and every application would have refused to start in production
because HSTS was refused-when-absent rather than forced-on.

**Why not PASS:** six high-severity dependency advisories are open. All have fixes; none has been
applied, because changing the dependency tree mid-pilot would have changed what was being measured.

### 4. Identity — PARTIAL

The local provider is verified live: login, an authorized read, and refusals for invalid and
expired tokens. The framework's OIDC provider is implemented and tested in its own suite.

**Why not PASS:** no OIDC provider was configured for this run, so nothing here demonstrates the
path a production deployment would use.

### 7. Audit — PASS

The append-only trigger refuses `UPDATE` and `DELETE`, verified **against the restored database**:

```text
ERROR:  AuditLog is append-only: UPDATE is not permitted
ERROR:  AuditLog is append-only: DELETE is not permitted
```

That is the check most easily missed. `pg_dump` restores triggers; a `--data-only` restore, or one
into a schema created by `db push`, would produce every row with the guarantee gone — and nothing
about querying the table would say so.

### 11. Health — PASS

With the database stopped: `/health` **200**, `/ready` **503** with
`{"name":"database","status":"down","detail":"database unreachable"}`. The process stayed alive and
recovered without a restart when the database came back.

No connection string in the readiness body.

### 12. Observability — PARTIAL

Every request line carries a request id, an actor, an organization, a status and a duration.
Correlation ids propagate and are echoed. Configuration is redacted in the start-up line.

**Why not PASS:** no metrics backend is adopted, so there are no metrics, no traces and no
dashboard. The seams exist; the seam being present is not the system being observable.

### 13 and 14. Backup and Restore — PASS

A backup was taken (111ms, 244 KB), restored into an isolated database (188ms), and the application
started against it (1,061ms) with the full smoke suite re-run: **10 passed, 0 failed, 1 skipped**.

Schema identical (82 tables), row counts identical, migration history intact (9 migrations with a
`finished_at`), append-only trigger still enforcing.

**What this does not establish:** that _Railway's_ managed backup and restore works. It has not been
exercised. The 188ms says nothing about a production estate — `@trustos/recovery`'s rule is that the
measured time is the slowest successful run, and this is one run on 244 KB.

### 17. Smoke tests — PASS

Eleven checks against `api-example` in production mode with PostgreSQL 17: **10 passed, 0 failed,
1 skipped**. The skip is the AI gateway, which is not configured, and the report says so rather
than counting it.

Two of the checks were wrong before they were right, which is the argument for running them: the
access token is under `tokens` rather than at the top level, and the error-shape check asserted a
production behaviour against a development service where the debug payload is intended.

## Remediation, in order

1. **Apply the six dependency fixes.** All have fixes available.
2. **Set `OPENAPI_ENABLED=false` on the live service.** One variable, no deploy, closes the
   publicly-exposed API specification immediately.
3. **Set the identity variable, then deploy the security-header fix.** In that order — the deploy
   is an outage otherwise.
4. **Run the smoke tests against the deployment.** The same command, a different URL.
5. **Create `trustos-uat`** with its own database and its own secrets.
6. **Exercise Railway's own backup and restore.** Different from the one performed here, with
   different failure modes.
7. **Configure OIDC** in UAT, which moves Identity off PARTIAL.
8. **Adopt a metrics backend.** One adapter.

## The gate

**GO for a Railway DEV and UAT pilot**, after the two live findings are closed.

The framework builds from a clean checkout, 5,493 tests pass, the image builds and runs, the
migrations apply, the health split behaves correctly under a real database failure, the audit
guarantee survives a restore, and ten of eleven smoke checks pass against a live service.

**NOT go for production.** The two unverified items are deployment, and beyond them: no OIDC, no
metrics backend, no multi-replica testing, six open advisories, and Railway's own backup and
restore unexercised.

**`v0.1.0-alpha` is the honest tag today.** `v0.1.0-pilot` after a DEV deployment with its smoke
tests green. Not `v1.0.0` — a `1.0` says the API is stable and the operational story is proven, and
neither is true.
