# Pilot readiness scorecard

Eighteen categories. **PASS requires evidence**, and a category with no evidence is FAIL rather
than PARTIAL.

## The scorecard

| #   | Category           | Score       | Evidence                                                                                                                 |
| --- | ------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Build              | **PASS**    | `npm run build` clean; `tsc -b` across 171 packages and 11 apps                                                          |
| 2   | Tests              | **PASS**    | 5,493 tests across 225 files, all passing                                                                                |
| 3   | Security           | **PARTIAL** | [`../security/pilot-security-review.md`](../security/pilot-security-review.md) — 6 advisories open, all with fixes       |
| 4   | Identity           | **PARTIAL** | Local provider verified live; OIDC configured and not exercised                                                          |
| 5   | RBAC               | **PASS**    | Live: auditor 403, owner 201, same route                                                                                 |
| 6   | Tenant isolation   | **PASS**    | Live: 403 on a foreign organization; 11 pilot tests against services                                                     |
| 7   | Audit              | **PASS**    | Append-only trigger verified **after a restore** — see below                                                             |
| 8   | Workflow           | **PASS**    | Framework suite; the pilot's maker-checker in [`../pilot/evidence/maker-checker.md`](../pilot/evidence/maker-checker.md) |
| 9   | Policy             | **PASS**    | Live ALLOW and DENY, both recorded with the policy version                                                               |
| 10  | Database migration | **PASS**    | 9 migrations applied clean; safety gate in CI, both paths verified                                                       |
| 11  | Health             | **PASS**    | Live: `/health` 200 and `/ready` 503 with the database stopped                                                           |
| 12  | Observability      | **PARTIAL** | Structured logs with correlation ids verified live; no metrics backend                                                   |
| 13  | Backup             | **PASS**    | [`evidence/restore-test.md`](evidence/restore-test.md) — taken, restored, validated                                      |
| 14  | Restore            | **PASS**    | Performed. Schema, data, migration history and append-only all intact                                                    |
| 15  | DEV deployment     | **FAIL**    | **Not performed.** No Railway project exists                                                                             |
| 16  | UAT deployment     | **FAIL**    | **Not performed.** No Railway project exists                                                                             |
| 17  | Smoke tests        | **PASS**    | 10 passed, 0 failed, 1 skipped, against a live service                                                                   |
| 18  | Documentation      | **PASS**    | This directory, plus the release and security documents                                                                  |

**12 PASS · 4 PARTIAL · 2 FAIL**

## The two FAILs

**Nothing has been deployed to Railway.** No project was created, no service was provisioned, no
domain was assigned.

This is FAIL rather than PARTIAL because nothing was demonstrated. Everything needed to deploy
exists and is verified locally — the image builds, the container runs, the migrations apply, the
smoke tests pass — and none of that is a deployment.

Creating a Railway project requires an account, a billing relationship and a decision about who
owns it. The specification says not to silently create external paid services, and provisioning
infrastructure on somebody's account is the clearest possible case of that.

**What is ready:** the topology, the Dockerfile, seven `railway.json` files, the variable list, the
migration strategy, the health checks and the exact commands, in
[`railway.md`](railway.md).

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
2. **Create `trustos-dev` on Railway and deploy.** Everything needed exists.
3. **Run the smoke tests against the deployment.** The same command, a different URL.
4. **Create `trustos-uat`** with its own database and its own secrets.
5. **Exercise Railway's own backup and restore.** Different from the one performed here, with
   different failure modes.
6. **Configure OIDC** in UAT, which moves Identity off PARTIAL.
7. **Adopt a metrics backend.** One adapter.

## The gate

**GO for a Railway DEV and UAT pilot.**

The framework builds from a clean checkout, 5,493 tests pass, the image builds and runs, the
migrations apply, the health split behaves correctly under a real database failure, the audit
guarantee survives a restore, and ten of eleven smoke checks pass against a live service.

**NOT go for production.** The two FAILs are deployment, and beyond them: no OIDC, no metrics
backend, no multi-replica testing, six open advisories, and Railway's own backup and restore
unexercised.

**`v0.1.0-alpha` is the honest tag today.** `v0.1.0-pilot` after a DEV deployment with its smoke
tests green. Not `v1.0.0` — a `1.0` says the API is stable and the operational story is proven, and
neither is true.
