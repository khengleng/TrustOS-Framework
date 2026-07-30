# AGENTS.md — rules for AI coding agents in this repository

This file governs automated changes to the TrustOS Engineering Framework itself.
Generated applications get their own `AGENTS.md` from `templates/_base`; the
product-level guidance lives in [docs/ai-agent-instructions.md](docs/ai-agent-instructions.md)
and the standards in [docs/coding-standards.md](docs/coding-standards.md) and
[docs/security-standards.md](docs/security-standards.md).

Read this before changing anything under `packages/identity`, `packages/authorization`,
`packages/api-keys`, `packages/service-accounts`, `packages/session-security`,
`packages/security-events`, `packages/security-policy` or `packages/security-testing`.

---

## The thirteen rules

Every rule below describes a change that **compiles, passes an unmodified test suite,
and silently removes a security control**. That is why they are stated as rules rather
than left to review: none of them is caught by a type checker, and several were caught
here only by a test written specifically to catch them.

### 1. Never bypass identity validation

There is one way an actor comes into existence: `AuthenticationGuard` resolves exactly
one `CredentialAuthenticator`, which verifies a credential and returns an
`ActorContext`. No route reads a user id from a header, a query parameter or a body
field. No test helper that fabricates an actor may be exported from a non-test entry
point.

### 2. Never decode a token without verifying its signature

`jwtDecode`, `JSON.parse(atob(...))` and `jose.decodeJwt` are not authentication. If a
claim influences a decision, the token must have been verified first — signature,
algorithm, issuer, audience, expiry. `packages/security-testing` provides
`algNoneToken`, `signedByAnotherKey` and `tamperedPayload` precisely so that a new
provider proves it refuses them.

### 3. Always validate the issuer and the audience

A correctly signed token from a different issuer is somebody else's token. A token
whose `aud` names a different client was minted for a different application, and
accepting it makes this application a confused deputy. Both are required in production
and `productionPolicyProblems` refuses a configuration that omits either.

### 4. Never trust client-supplied roles

Roles and permissions are resolved on the server, per request, from the membership
tables. A provider that copies `realm_access.roles` straight into `ActorContext.roles`
without mapping and without a server-side membership check has made the token the
authorization decision. `OidcIdentityProvider.mapRoles` uses an explicit map and
reports what it could not map.

### 5. Never trust client-supplied organization scope

The organization comes from the verified actor and the server-side membership lookup.
An `X-Organization-Id` header naming an organization is a request, not a fact.
`TenantGuard` and `tenantMembershipPolicy` both check it, and
`packages/authorization` has explicit tests for header manipulation, inactive
membership and invitation-token reuse.

### 6. Default authorization decisions to deny

`authorize()` returns deny unless a policy explicitly allows. A new policy that cannot
form an opinion returns "no opinion", which means deny. Never write a policy that
allows on an unknown case, and never reorder the policy list so that something other
than `rbac.permission` gets the last word.

### 7. Never store plaintext API keys

Only `keyPrefix`, `keyHash` and metadata are persisted. The plaintext exists for the
lifetime of one response — `create` and `rotate` — and no other code path can produce
it, because no code path has it. Do not add a "reveal key" endpoint; there is nothing
to reveal.

### 8. Never log tokens or credentials

Not at debug level, not temporarily, not while investigating an incident. Log the
prefix (`tos_live_abcd…`) or `correlationHash(value, salt)`. `redactSecrets` strips
secret-named fields, but it is a safety net and not a licence: a field named
`data` holding a token is not caught by any name-based redactor.

### 9. Preserve refresh-token reuse detection

A used refresh token presented a second time revokes the whole rotation family and
emits `session.refresh_reuse_detected` at critical severity. This is the only signal
the framework has that a refresh token was stolen. `usedAt` and `revokedAt` are
separate columns for this reason; collapsing them turns a theft into an ordinary
rejection and leaves the thief's session alive.

### 10. Add negative security tests

A test that a valid token works proves nothing about a tampered one. Every credential
path needs tests that the wrong input is refused — and refused _identically_, so the
error does not distinguish "no such account" from "wrong password" from "locked".
`SECURITY_TEST_CATEGORIES` in `@trustos/security-testing` lists the categories a new
credential type is expected to cover.

### 11. Document new permissions and scopes

Add the key to `PERMISSIONS` in `packages/rbac/src/permissions.ts` with a description,
and grant it to the roles that should hold it, before using it. Never rename or
repurpose an existing key: a renamed key silently grants or revokes access on every
deployment that has not been migrated.

### 12. Audit all privileged operations

Credential creation, revocation and rotation; role and permission changes; session
revocation; service-account lifecycle. `AuditService` for what a customer must be able
to reconstruct, `SecurityEventEmitter` for what was attempted and refused. The two are
different trails with different audiences — see
[docs/security-testing.md](docs/security-testing.md).

### 13. Stop after the approved scope is complete

Do not add infrastructure, providers or integrations that were not asked for. In
particular this phase deliberately contains no Redis, no external secrets manager, no
custom OTP system, no SMS delivery and no cloud storage. Where one of those would go,
there is a documented port. Extend the port; do not add the dependency.

---

## Guard order is the security model

`apps/security-admin-example/src/security-admin.module.ts` registers seven global
guards. Nest applies them in registration order:

```
AuthenticationGuard           who is calling?              -> request.actor
TenantGuard                   whose data may they see?     -> request.organizationId
InteractiveRouteGuard         is this route for a person?
AuthenticationAssuranceGuard  did they prove it strongly enough?
PermissionsGuard              may they do this at all?     (deny by default)
ScopeGuard                    may this credential do it?
PolicyAuthorizationGuard      does the full policy set allow it?
```

Each one can only refuse. Reordering them is a security review, not a refactor — in
particular, assurance runs before permissions so that a privileged role with no second
factor is stopped before its permissions are consulted. `security-admin.spec.ts`
asserts this order against the running injector, so a reordering fails a test rather
than passing quietly.

## Before claiming a change is done

```bash
npm run lint
npm run format:check
npm run build:packages
npm test
npm run migrate:drift -w @trustos/database   # needs a database
```

All of them must pass. **Never claim something works because it compiles.** If a test
fails, say which one and what the output was.
