# Service account security

Identities for machines. Not human accounts with the display name changed.

- [Why not a human account](#why-not-a-human-account)
- [Two modes](#two-modes)
- [No interactive login](#no-interactive-login)
- [Never platform staff](#never-platform-staff)
- [Lifecycle](#lifecycle)
- [Rotation without a grace period](#rotation-without-a-grace-period)
- [Configuration](#configuration)
- [Choosing between a service account and an API key](#choosing-between-a-service-account-and-an-api-key)

---

## Why not a human account

The shortcut is to create `integrations@company.com`, give it a password and a role, and
hand the credential to the nightly job. Four things then break, and they break at the
worst time:

- **The audit trail lies.** Every record says a person did it. When a reconciliation job
  reverses 400 transactions, the trail names an employee.
- **Offboarding breaks production.** Somebody leaves, their account is disabled, and a
  batch job stops. Or — worse — nobody disables it, because disabling it broke
  something last time.
- **The credential is over-privileged.** A person's account carries a person's
  permissions, which is always more than a job needs.
- **MFA is impossible.** A machine cannot present a second factor, so either the
  account is exempt (a permanent hole) or the job cannot run.

A service account fixes all four by being a distinct actor type:

```ts
actor.actorType === 'service_account';
```

`AuditLog.actorType` records it, so "suspended by service account `ledger-sync`" and
"suspended by `user_9f2`" are distinguishable facts.

## Two modes

**OIDC (recommended in production).** The provider issues tokens via the
client-credentials grant. The `ServiceAccount` row holds roles, scopes and status,
keyed by the provider's client id. **The framework holds no secret at all** — rotation
is the provider's problem, and there is nothing in the database for an attacker to
steal.

**Local.** The framework issues a `tos_sa_<40 chars>` credential, hashed the same way
an API key is. For development, for tests, and for deployments with no identity
provider.

A distinct prefix from an API key on purpose: the two are different things with
different rules, and a credential whose type is visible in a log or a configuration file
is one nobody misfiles.

**An account cannot have both.** `create` refuses a request with an `oidcClientId` and
`issueCredential: true`. Two credentials for one identity means two things to rotate and
two ways in, and nobody keeps both inventories current.

## No interactive login

`InteractiveRouteGuard` refuses a machine actor on any route marked
`@HumanActorsOnly()`, and it runs before the permissions guard.

The routes that matter: login, password reset, MFA enrolment, session management, API
key and service-account administration. A service account that could create service
accounts is an escalation path that outlives its own credential — the same reasoning as
API keys, and enforced the same way.

The complement, `@AllowActorTypes('service_account', 'api_key')`, marks a route that is
_only_ for machines. A webhook receiver has no reason to accept a browser session.

## Never platform staff

`isSuperAdmin` is forced to `false` for every service account. There is no configuration
that changes this.

Platform-wide authority means the ability to act across every organization, and it
should belong to somebody who can be asked why they used it. A machine cannot answer
that question. If a job genuinely needs cross-organization reach, it gets one service
account per organization — which is more work, and is also an inventory of exactly what
has that reach.

## Lifecycle

**Create** — validates scopes, refuses a duplicate name, caps the lifetime, records who
created it. `createdById` is the person who created the account; it is deliberately not
the actor the account authenticates as, which is the account itself.

**Disable, not delete.** `status: 'disabled'`, and the row stays. An account that acted
on production data must not become an orphaned id in an audit record — a trail that
says "modified by `sa_8812`, no such account" is not a trail. Idempotent: disabling
twice emits one event.

**Use tracking** — `lastUsedAt`, `lastUsedIp`. The point is finding integrations that
nobody uses any more. An enabled credential for a decommissioned system is the one
nobody is watching.

**Expiry** — optional, capped by policy. Recommended for anything built for a
migration or a one-off: a temporary integration with a permanent credential is a
permanent integration nobody remembers.

## Rotation without a grace period

API key rotation leaves the old key valid for 24 hours. Service-account rotation does
not, and the difference is intentional.

An API key is often held by a third party you have to email, who will deploy it when
they get to it. A service account is held by infrastructure you control, which
reconnects on its next run. The grace period buys coordination you do not need, and
costs a second valid long-lived machine credential for as long as the window lasts.

So: schedule the rotation, deploy the new value, let the integration reconnect. The
response says so explicitly.

`rotateCredential` refuses an OIDC-backed account — rotate the client secret at the
provider, which owns it.

## Configuration

Service accounts share the API key policy block:

| Variable                        | Default | Meaning                      |
| ------------------------------- | ------- | ---------------------------- |
| `SECURITY_API_KEY_MAX_PER_ORG`  | 20      | Also caps service accounts   |
| `SECURITY_API_KEY_MAX_LIFETIME` | 730d    | Ceiling on `lifetimeSeconds` |

For OIDC mode, see the client-credentials setup in
[enterprise-identity.md](enterprise-identity.md). The example realm includes a
`ledger-sync` client so the path is exercisable without creating one by hand.

Permissions: `security.service_account.read`, `.create`, `.manage`.
`organization_owner` holds all three; `administrator` holds read and manage — it can
disable an account during an incident but not create one; `auditor` holds read only.

## Choosing between a service account and an API key

|                         | Service account                    | API key                                    |
| ----------------------- | ---------------------------------- | ------------------------------------------ |
| Caller                  | your own infrastructure            | a third party, or a customer's integration |
| Credential owner        | your identity provider (OIDC mode) | the framework                              |
| Roles                   | yes                                | no — scopes only                           |
| Rotation                | immediate                          | 24-hour grace                              |
| Interactive routes      | refused                            | refused                                    |
| Distinct audit identity | yes                                | yes (the key's id)                         |

A nightly reconciliation job is a service account. A customer calling your public API is
an API key. When both fit, prefer the service account: it carries roles, which compose
with the rest of the authorization model instead of sitting beside it.

---

**See also:** [api-key-security.md](api-key-security.md) ·
[enterprise-identity.md](enterprise-identity.md) ·
[authorization-model.md](authorization-model.md) ·
[threat-model.md](threat-model.md)
