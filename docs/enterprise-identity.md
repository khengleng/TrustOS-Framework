# Enterprise identity

How TrustOS authenticates. One abstraction, two providers, one normalized actor.

- [The shape of the thing](#the-shape-of-the-thing)
- [The normalized actor](#the-normalized-actor)
- [Local identity](#local-identity)
- [OIDC identity](#oidc-identity)
- [Running Keycloak locally](#running-keycloak-locally)
- [Choosing a mode](#choosing-a-mode)
- [Multi-factor readiness](#multi-factor-readiness)
- [Configuration](#configuration)
- [Production checklist](#production-checklist)
- [What is deliberately absent](#what-is-deliberately-absent)

---

## The shape of the thing

Application code never mentions Keycloak. It depends on one interface:

```ts
interface IdentityProvider {
  readonly id: string;
  readonly kind: 'local' | 'oidc';
  readonly supportsPasswordAuthentication: boolean;
  readonly supportsCentralSessionRevocation: boolean;

  authenticate(credentials, meta): Promise<AuthenticationResult>;
  validateAccessToken(token, meta): Promise<VerifiedIdentity>;
  getProfile(userId): Promise<IdentityProfile | null>;
  logout(input): Promise<void>;
  revokeSessions(userId): Promise<number>;
  mapRoles(claims): RoleMapping;
  health(): Promise<HealthResult>;
}
```

Two implementations ship: `LocalIdentityProvider` and `OidcIdentityProvider`. The
composition root selects **exactly one**. Two providers that could each authenticate
the same request would mean the weaker one decides, so `loadSecurityPolicy` refuses
`local` alongside `oidc` in production.

The two capability booleans exist because the honest answer to "can you sign this user
out everywhere?" differs by provider, and an administrative UI that claims a global
revocation it did not perform is worse than one that says it cannot.

`OidcIdentityProvider` is written against the OpenID Connect specification and reads
Keycloak's realm and client role claims _if they are present_. There is no Keycloak
SDK, no admin-API dependency and no Keycloak-specific type in any signature. Any
compliant issuer works; Keycloak works particularly well because its claim shape is
the one the role mapper already understands.

## The normalized actor

Every authenticated request produces the same object, whoever is calling:

```ts
interface ActorContext {
  actorType: 'user' | 'service_account' | 'api_key' | 'system';
  userId: string;
  email: string | null;
  organizationId: string | null;
  roles: string[];
  permissions: string[];
  isSuperAdmin: boolean;
  tokenId: string | null;
  scopes?: string[];
  authentication?: {
    mfa: boolean;
    level: 'low' | 'medium' | 'high';
    methods: string[];
    acr: string | null;
    authenticatedAt: Date | null;
  };
  provider?: string;
  sessionId?: string;
}
```

`actorType` is required and it is not cosmetic: it is what makes an audit record
answerable. "Merchant 4182 was suspended by `user_9f2`" and "…by service account
`ledger-sync`" are different facts, and a system that cannot tell them apart cannot
answer the first question an auditor asks. It is persisted on `AuditLog.actorType` and
on every security event.

`permissions` is always resolved server-side. Nothing in the framework reads a
permission from a token claim — see rule 4 in [AGENTS.md](../AGENTS.md).

`isHumanActor` and `isMachineActor` exist so that a policy can express "a person must
do this" without enumerating the machine types and getting it wrong when a fifth type
is added.

## Local identity

For development, for tests, and for deployments with no identity provider.

**Password hashing** is scrypt from `node:crypto`, with N=2¹⁷, r=8, p=1 and a 64-byte
key. The parameters are encoded into the stored hash
(`$scrypt$N=131072,r=8,p=1$salt$hash`), so raising the cost later does not invalidate
existing hashes: `identifyHash` reports what a stored hash used, and a successful login
transparently re-hashes anything below the current parameters. Bcrypt hashes from
phase 1 are recognised and upgraded the same way.

scrypt rather than bcrypt because it is memory-hard and in the standard library.
Argon2id would be the other defensible choice; it is not in the standard library, and
adding a native dependency to the security-critical path was a worse trade than using
a memory-hard KDF that ships with Node. The `PasswordHasher` port is the seam if you
disagree — implement it, and nothing else changes.

**Password rules** are minimum length 12, a check against a small list of the
passwords that appear in every breach corpus, and nothing else. Specifically:

- No composition rules (one upper, one digit, one symbol). They push users toward
  `Password1!` and measurably reduce entropy.
- **No scheduled rotation.** `rotationDays` is typed `z.null()` — not merely defaulted
  to null, but impossible to set. NIST withdrew the recommendation because forced
  rotation produces `Summer2024!` → `Autumn2024!`. Rotation on evidence of compromise
  is a different thing and is supported.

**The compromised-password interface** is `CompromisedPasswordChecker`. The shipped
`WellKnownPasswordChecker` holds a small in-process list. A real corpus or an external
range-query service goes behind the same interface; this phase integrates neither.

**Login order** matters, and the order is:

1. Check the lockout counter. Before hashing, so a locked account spends no CPU.
2. Look up the user. **On a miss, verify against a dummy hash anyway**, so a
   non-existent account takes the same time as a real one.
3. Verify the password.
4. Re-hash if the stored parameters are below current.
5. Clear the failure counter.

Every failure — unknown email, wrong password, deactivated account, soft-deleted
account, locked account — returns the identical message and the identical error code.
`context.reason` distinguishes them for the server's own logs. This is tested: a spec
asserts that the set of distinct client-visible messages across all failure modes has
size one. An earlier version of `lockedOutError` failed that test.

**Lockout** is a counter with a threshold and a window, backed by the `LockoutStore`
port. The shipped store is in-process, which means N instances behind a load balancer
give an attacker N times the attempts. That is a real limitation, stated rather than
hidden; a shared store is a one-class change and this phase adds no Redis.

## OIDC identity

`OidcIdentityProvider` validates an access token by:

1. Fetching the issuer's JWKS via `createRemoteJWKSet`, which caches keys and
   re-fetches on an unknown `kid` with a cooldown — so a key rotation is handled
   without a restart and without a fetch per request.
2. Verifying the signature against a **pinned algorithm list**. `none` is not in it.
   Neither is any HMAC algorithm, because an attacker who can set `alg: HS256` and sign
   with the public key as the secret has forged a token.
3. Checking `iss` exactly.
4. Checking `aud`, and `azp` when present — the claim that says which client the token
   was actually issued to.
5. Checking `exp`, `nbf` and `iat` with a small skew (30 seconds by default; skew is a
   grace period during which an expired token still works, so a generous value is a
   quiet extension of every token lifetime).

Every rejection produces one opaque error, `oidc_token_rejected`. The specific reason
goes to the security event, not to the caller: an error that says "audience mismatch"
tells an attacker exactly which of five things to fix next.

`authenticate` **throws**. There is no password path in OIDC mode, and a provider that
quietly fell back to one would be a way to bypass the issuer.

`revokeSessions` throws when no back channel is configured, rather than returning 0 and
letting an administrator believe a revocation happened.

**Role mapping** is explicit. `realm_access.roles` and
`resource_access.<clientId>.roles` are read if present, mapped through a configured
`roleMap`, and anything unmapped is _reported_ in `RoleMapping.unmapped` rather than
silently dropped — so a realm role that nobody wired up is visible instead of being an
inexplicable 403.

## Running Keycloak locally

Everything needed is in [`examples/keycloak/`](../examples/keycloak/):

```bash
cd examples/keycloak
cp .env.example .env          # then edit: the file ships with no password
docker compose up -d

# Import the development realm (or let compose do it — see the compose file).
./import-realm.sh
```

Then point an application at it:

```bash
IDENTITY_PROVIDER=oidc
OIDC_ISSUER_URL=http://localhost:8080/realms/trustos-dev
OIDC_CLIENT_ID=trustos-api
```

The realm export (`realm-trustos-dev.json`) defines the realm, one public client for
the frontend (authorization code + PKCE, no secret), one confidential client for the
API, four realm roles matching the TrustOS system roles, and two test users. **It
contains no administrative credentials.** The compose file reads the admin user and
password from the environment and `.env` is gitignored — see
[`examples/keycloak/README.md`](../examples/keycloak/README.md).

TrustOS does **not** deploy Keycloak. There is no `trustos new --with-keycloak`, and
the CLI never provisions an identity provider. Running an identity provider is an
infrastructure decision with its own backup, upgrade and availability story, and a
framework that silently stood one up would be making that decision for you.

For Railway, run Keycloak as its own service with its own Postgres, set
`KC_HOSTNAME` to the public domain, terminate TLS at the edge, and set
`OIDC_ISSUER_URL` to the `https://` issuer — the policy loader refuses a non-https
issuer in production. Details in [railway-deployment.md](railway-deployment.md).

## Choosing a mode

`trustos new <template> --identity-provider local|oidc`, defaulting to `local`.

The default is local because a generated application has to start on the first
attempt. `oidc` requires an issuer that exists, and an application that cannot boot
until Keycloak is running is a worse first experience than one that boots and is
switched later by editing one variable.

Switching is `IDENTITY_PROVIDER=oidc` plus `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID`. The
generated `.env.example` contains both forms — the active one uncommented, the other
commented — so switching is uncommenting rather than remembering.

`trustos.json` records which mode an application was generated for, so `trustos
add-module` and later upgrades do not have to guess from its environment file.

## Multi-factor readiness

TrustOS **does not implement a second factor**. It implements the ability to require
one, which is a different and smaller thing.

```ts
@RequireMfa()
@Post('api-keys')
create() {}

@RequireAuthenticationLevel('high')
@Get('policy')
policySummary() {}
```

`AuthenticationAssuranceGuard` enforces these against `ActorContext.authentication`,
which is derived from the token's `acr` and `amr` claims. An unrecognised `acr` maps to
`low` — the safe direction. Machine actors are exempt, because "did this integration
present a second factor" is not a meaningful question.

The policy can also require a second factor for named roles
(`mfa.requiredForRoles`), which is why the assurance guard runs _before_ the
permissions guard: a privileged role with no second factor is stopped before its
permissions are consulted.

There is deliberately **no custom OTP system**, no TOTP secret storage, no SMS
integration and no authenticator-app enrolment. Keycloak already does all of it,
correctly, with recovery codes and enrolment flows that took years to get right. In
local mode, `authentication.mfa` is false and `@RequireMfa()` refuses — which is the
correct behaviour for a deployment that has no second factor, rather than a pretence
that it does.

## Configuration

| Variable                                      | Default       | Meaning                                            |
| --------------------------------------------- | ------------- | -------------------------------------------------- |
| `IDENTITY_PROVIDER`                           | `local`       | `local` or `oidc`. Exactly one.                    |
| `SECURITY_TOKEN_ISSUER`                       | `trustos`     | Required `iss`.                                    |
| `SECURITY_TOKEN_AUDIENCE`                     | `trustos-api` | Required `aud`.                                    |
| `OIDC_ISSUER_URL`                             | —             | Required when `oidc`. Must be https in production. |
| `OIDC_CLIENT_ID`                              | —             | Required when `oidc`.                              |
| `OIDC_CLIENT_SECRET`                          | —             | Confidential-client secret. Never committed.       |
| `OIDC_ROLE_MAP`                               | `{}`          | JSON: provider role → TrustOS role.                |
| `OIDC_END_SESSION_ENDPOINT`                   | —             | Enables back-channel logout.                       |
| `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION` | `false`       | Explicit opt-in.                                   |

Full list, including sessions, lockout and API keys, in
[session-security.md](session-security.md) and [api-key-security.md](api-key-security.md).

## Production checklist

- [ ] `IDENTITY_PROVIDER=oidc`, or `SECURITY_ALLOW_LOCAL_IDENTITY_IN_PRODUCTION=true`
      as a recorded decision.
- [ ] `OIDC_ISSUER_URL` is `https://`.
- [ ] `OIDC_CLIENT_ID` set; `aud`/`azp` validation confirmed against a real token.
- [ ] Frontend client is **public** with authorization code + PKCE. No client secret
      in a browser bundle.
- [ ] API client is **confidential**; its secret comes from the platform's secret
      store, not from a file in the repository.
- [ ] `OIDC_ROLE_MAP` covers every realm role that should grant anything. Check the
      `unmapped` list in the logs after the first few logins.
- [ ] Keycloak has its own Postgres, with backups.
- [ ] Token lifetimes in Keycloak match `tokens.accessTokenSeconds`.
- [ ] Brute-force detection enabled in the realm (Keycloak's, not the framework's).
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are different, ≥32 characters, and not
      from the placeholder list. The policy loader checks all three.
- [ ] Admin console not exposed publicly.
- [ ] No administrative credential anywhere in git history.

## What is deliberately absent

No Keycloak admin-API coupling. No user provisioning or SCIM. No custom OTP, SMS or
authenticator app. No biometric or national-identity integration. No social login. No
Redis-backed lockout. No external secrets manager.

Each of those has a port or a documented extension point where it would go. Adding one
is a decision with operational consequences, and the framework's job here is to make
it possible, not to make it for you.

---

**See also:** [authorization-model.md](authorization-model.md) ·
[session-security.md](session-security.md) ·
[api-key-security.md](api-key-security.md) ·
[service-account-security.md](service-account-security.md) ·
[security-testing.md](security-testing.md) ·
[threat-model.md](threat-model.md) ·
[incident-response.md](incident-response.md)
