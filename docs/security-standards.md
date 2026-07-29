# Security standards

Rules for anyone — human or AI agent — changing code in this repository.
A change that violates one of these is not merged, regardless of what it fixes.

---

## 1. Non-negotiables

1. **Never weaken authentication or authorization to make something work.**
   If a route needs different access, change the permission it declares — do not
   remove the decorator, do not add `@Public()`, do not bypass a guard.
2. **Never bypass tenant isolation.** Not "temporarily", not "just for an
   admin screen", not behind a feature flag.
3. **Every security-sensitive change ships with a test.** Authentication,
   authorization, tenancy, audit, error disclosure, secret handling.
4. **Every sensitive action is audited.** If a reviewer cannot answer "who did
   this and when" from the audit trail, the change is incomplete.
5. **No secrets in the repository.** Not in code, config, tests, fixtures,
   comments or commit messages. CI fails on tracked `.env`/`.pem`/`.p12` files.

---

## 2. Authentication

- Passwords are hashed with bcrypt at `PASSWORD_HASH_ROUNDS` (12 in production).
  Never store, log, or transmit a plaintext password.
- Login gives the same answer for a wrong password and an unknown account, and
  spends the same time on both (`verifyPasswordAgainstDummy`). Do not add a
  "user not found" branch that returns early.
- Access and refresh tokens are signed with **different** secrets. `@trustos/config`
  refuses to start production if they match or are shorter than 32 characters.
- Token verification pins `algorithms: ['HS256']`. Removing that pin accepts
  `alg: none`.
- Refresh tokens rotate on every use. Replaying a rotated token revokes the whole
  family — the legitimate user is signed out, the thief gains nothing.
- Refresh tokens are stored as SHA-256 hashes. A database leak does not hand an
  attacker live sessions.
- `tokenVersion` on `User` invalidates every outstanding token for that user at
  once. It is the breach-response lever.

**Not implemented in this phase:** Google, Apple, passkeys, Keycloak, MFA,
password reset, email verification, account lockout, rate limiting. Do not add
them speculatively — see `docs/ai-agent-instructions.md`.

---

## 3. Authorization

- `PermissionsGuard` denies any authenticated route that declares no policy.
  A route must carry `@RequirePermissions`, `@RequireRoles`,
  `@AllowAnyAuthenticated` or `@Public`. Forgetting produces a 403 in staging,
  not an open endpoint in production.
- Least privilege is the default. `operator` and `auditor` hold no write
  permission. `super_admin` is the only holder of the wildcard, and it is a flag
  on the user, not a role an organization can grant.
- `canGrantRole` limits which roles a holder may grant. Without it,
  `rbac.role.assign` is effectively `platform.admin`.
- Permission checks happen server-side, always. Hiding a button is not a control.
- A `forbidden` response never tells the caller which permission they lack; the
  detail goes to `ApiError.context`, which reaches logs and never the wire.

---

## 4. Tenant isolation

The seven rules are in `docs/architecture.md` §6. In review terms:

- Reading a tenant-owned model without `organizationId` in the `where` clause is
  a blocking finding.
- `findUnique` on a tenant-owned model is a blocking finding unless the result
  passes through `assertTenantMatch`. Prefer `scopedDelegate`, which rewrites
  `findUnique` to a scoped `findFirst` automatically.
- A cross-tenant hit reports `not_found`, never `forbidden`. A 403 confirms the
  id exists in another organization, which turns any id endpoint into an
  enumeration oracle.
- `@CrossOrganization()` requires `isSuperAdmin` and is a review item every time
  it appears.
- New tenant-owned models require isolation tests before merge.

---

## 5. Errors and information disclosure

- Every non-2xx response is `{ error, message, requestId }`, plus `details` for
  validation errors only.
- In production, an unexpected error contributes **nothing** to the response —
  no message, no stack, no error class. It is logged in full.
- `ApiError.context` is diagnostic and is never serialized to a response.
- Database driver errors, connection strings and file paths must never reach a
  caller. The readiness probe reports `database unreachable`, not the driver's
  text.

---

## 6. Logging

Never logged, at any level, in any environment:

- passwords, password hashes, password reset tokens
- access tokens, refresh tokens, ID tokens, session ids
- JWT secrets, API keys, private keys, client secrets
- `DATABASE_URL` or any connection string
- full request bodies of authentication endpoints

Enforcement is in `packages/logging/src/redaction.ts`: a key-name deny list
applied at any depth, case- and separator-insensitive, plus Pino's path-based
redaction for known request shapes. **Add new sensitive field names to
`SENSITIVE_KEYS` when you introduce them** — the list is only as good as its
maintenance.

Query _parameters_ are never logged, only query text. Parameters routinely carry
email addresses and hashes.

Where a token must be correlated across log lines, use `tokenFingerprint`, which
keeps four characters — enough to match, not enough to replay.

---

## 7. Audit trail

Recorded for: login, failed login, logout, token refresh, token reuse detection,
session revocation, user creation, organization creation and update, member
invitation and removal, role assignment and revocation, permission changes, and
configuration changes.

Every record carries: actor id, organization id, action, entity type, entity id,
before, after, timestamp, request id, IP address, user agent.

- `AuditSink` has no `update` and no `delete`. Application-level immutability is
  a convention, so it is also enforced in the database by a `BEFORE UPDATE OR
DELETE` trigger, shipped as migration `20260729010000_auditlog_append_only`.

  **A `REVOKE` alone is not enough, and believing otherwise is worse than doing
  nothing.** The obvious control is:

  ```sql
  REVOKE UPDATE, DELETE ON "AuditLog" FROM trustos_app;
  ```

  That works only when the application connects as a role which does **not** own
  the table. PostgreSQL grants an owner implicit rights on its own objects, so
  when the application connects as the owner — the default on Railway and on
  most single-role deployments — the `REVOKE` reports success and changes
  nothing. This was verified against the live deployment: after the revoke, an
  `UPDATE` still reported `UPDATE 1`. The trigger applies to the owner too, so it
  holds under the topology we actually have.

  Use both where you can: run the application as a non-owner role **and** keep
  the trigger. They are complementary.

  Neither stops a superuser, who can drop the trigger. That is a known residual
  risk: defending against a compromised database administrator requires shipping
  records off-host to append-only storage, which is a later phase.

- `before`/`after` are redacted with the logging rules before they are written.
- `AuditLog` has no foreign keys on purpose: a record must survive deletion of
  the actor, the organization or the entity, and must never be removed by a
  cascade.
- Reads are organization-scoped and require `audit.read`.

---

## 8. Configuration and secrets

- `@trustos/config` is the only reader of `process.env` (enforced by eslint).
- Production refuses to start on: a missing required variable, a secret under 32
  characters, a known placeholder secret, identical access/refresh secrets,
  wildcard CORS, or a non-PostgreSQL `DATABASE_URL`.
- Only the allow-list in `toPublicConfig` may reach a browser. It is an
  allow-list, not a deny-list, so a newly added secret cannot leak by omission.
- `NEXT_PUBLIC_*` variables are embedded in the client bundle. The only one this
  framework uses is the API base URL.
- Generate production secrets with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
- Rotate `JWT_SECRET` by deploying the new value; outstanding access tokens
  become invalid within one TTL. Rotate `JWT_REFRESH_SECRET` only alongside a
  forced re-authentication.

---

## 9. Dependencies

- CI fails on high or critical advisories (`npm audit --audit-level=high`).
- Transitive advisories are pinned forward with `overrides` in the root
  `package.json` rather than by downgrading a direct dependency.
- Anything accepted rather than fixed is recorded below, with a reason and a
  review date. The list is currently empty.

| Advisory | Package | Accepted because | Review by |
| -------- | ------- | ---------------- | --------- |
| _(none)_ |         |                  |           |

---

## 10. Known limitations of this phase

These are deliberate and documented, not oversights. None should be treated as
"good enough for production" without a decision.

1. **The admin example stores tokens in `localStorage`.** A single XSS becomes
   account takeover. A production console should keep the refresh token in an
   `httpOnly; Secure; SameSite=Strict` cookie set by a server route, and hold
   the access token in memory only.
2. **No rate limiting.** There is nothing slowing down credential stuffing
   against `/auth/login`. Add a limiter (per IP and per account) before exposing
   a login endpoint publicly.
3. **No account lockout or breach detection** beyond refresh-token reuse.
4. **No password reset or email verification.** An invited user is created with
   an unusable password hash and cannot sign in until a reset flow exists.
5. **Access-token revocation is not immediate.** A revoked role or permission
   remains effective until the access token expires. `TokenRevocationChecker` is
   the hook for a Redis-backed deny list; it is not implemented.
6. **`auth.login_failed` records carry no organization**, because a failed login
   for an unknown address belongs to no organization. Those events are visible
   only in platform-level log review, not in an organization's audit view.
7. **Soft-deleted users keep their unique email.** The address cannot be
   re-registered while the row exists. Decide on a tombstone strategy before
   this matters.
8. **No field-level encryption.** Anything requiring encryption at rest beyond
   what the database provides needs a design decision first.
9. **CORS, TLS and security headers are deployment concerns.** Railway
   terminates TLS; `TRUST_PROXY` must be enabled there so the audit trail
   records real client IPs rather than the proxy's.
