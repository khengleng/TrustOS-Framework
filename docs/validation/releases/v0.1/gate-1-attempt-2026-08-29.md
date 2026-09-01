# Gate 1 / Gate 2 closure attempt — 2026-08-29

|             |                                                                               |
| ----------- | ----------------------------------------------------------------------------- |
| Commit      | `97a58b28452bcd31fb0f553dee1913da74593e0f`                                    |
| Environment | DEV — https://governance-tool-dev.up.railway.app                              |
| Realm       | `trustos-dev` (issuer verified: `https://id.cambobia.com/realms/trustos-dev`) |
| **Gate 1**  | **PARTIAL — stopped at task 1**                                               |
| **Gate 2**  | **NOT_REACHED**                                                               |

## Task 1 — validation client, verified by the client-credentials flow

**FAIL. The client is still public.** No token could be obtained, so no token metadata
exists to record.

```
POST /realms/trustos-dev/protocol/openid-connect/token
grant_type=client_credentials  client_id=trustos-foundation-validator

HTTP 401  unauthorized_client: Invalid client or Invalid client credentials
```

The distinction that identifies the cause, from the same endpoint in the same run:

| client_id                      | HTTP | error                     | meaning                                             |
| ------------------------------ | ---- | ------------------------- | --------------------------------------------------- |
| `trustos-foundation-validator` | 401  | **`unauthorized_client`** | Keycloak found the client and refused it this grant |
| `definitely-not-a-client-xyz`  | 401  | `invalid_client`          | no such client                                      |

`unauthorized_client` is what Keycloak returns for a client it can resolve but that is
not permitted the grant — i.e. **Client authentication is off (the client is public)
and/or Service accounts roles is off**. A confidential client with a wrong secret returns
`invalid_client`, which is not what happens here.

No secret is configured on the DEV service either: `TRUSTOS_VALIDATION_CLIENT_SECRET` is
absent.

### Realm state, for completeness

|                                 |                                                                 |
| ------------------------------- | --------------------------------------------------------------- |
| Issuer                          | `https://id.cambobia.com/realms/trustos-dev` — matches expected |
| `client_credentials` advertised | yes                                                             |
| Signing keys published          | 2 (RS256, RSA-OAEP)                                             |

### Clients present in `trustos-dev`

| Client                         | Present                          | State                                                       |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------- |
| `trustos-foundation-validator` | yes                              | **public** — cannot use client credentials                  |
| `trustos-web`                  | **yes — new since the last run** | exists, but **no redirect URI** accepted for the DEV portal |
| `trustos-api`                  | no                               | absent as a client; still valid as an audience string       |

## Task 2 — positive authentication

**NOT_REACHED.** Every step depends on a token task 1 could not obtain. Nothing is
recorded as passing; no inference is drawn from the realm being reachable.

## Task 3 — negative claim validation, re-verified at this commit

The provider reports which layer refused each token. Deployed measurement, read from the
service's own logs by request id:

| Test             | Expected layer | Observed layer     | HTTP | Result            |
| ---------------- | -------------- | ------------------ | ---- | ----------------- |
| anonymous        | guard          | guard              | 401  | **exercised**     |
| malformed bearer | format         | format             | 401  | **exercised**     |
| unpublished kid  | key_resolution | key_resolution     | 401  | **exercised**     |
| expired          | expiry         | **key_resolution** | 401  | **not exercised** |
| wrong issuer     | issuer         | **key_resolution** | 401  | **not exercised** |
| wrong audience   | audience       | **key_resolution** | 401  | **not exercised** |

All six are refused. Only the first three tested what their name says. The last three stop
at key resolution because a token this realm did not sign cannot reach a claim check —
and that is a property of the design, not a gap in the test.

Those three checks are covered at **cryptographic-integration level** by ten tests in
`packages/identity/src/oidc/oidc-provider.spec.ts`, each failing exactly one check with
everything before it correct. That evidence is real and is **not** promoted to deployed
evidence. Producing deployed evidence for them requires a token signed by the realm,
which requires either the validation client or the realm's private key.

## Task 4 — foundation decision

| Control            | Result      |
| ------------------ | ----------- |
| **Authentication** | **PARTIAL** |
| Multi-tenancy      | PASS        |
| RBAC               | PASS        |
| Policy             | PASS        |
| Workflow           | PASS        |
| Maker-checker      | PASS        |
| Audit              | PASS        |

Six of seven. **TrustOS Core Foundation v0.1 is not declared VALIDATED**, because the
condition for declaring it is all seven and that is not the case.

## Task 5 — Approval Workbench HTTP end to end

**NOT_REACHED.** All fourteen required checks need an authenticated identity.

What is proven deployed without one: all five workbench routes refuse anonymous access
with 401, distinct from 404 for a route that does not exist — so the routes are mounted
and the authentication guard is executing. That is the boundary refusing, not the
boundary working.

## Task 7 — regression at this commit

|                              |                              |
| ---------------------------- | ---------------------------- |
| Tests                        | **5,740 / 5,740**, 0 failing |
| Format check                 | pass                         |
| Lint                         | 0 errors                     |
| Build / typecheck            | exit 0                       |
| Foundation validator         | **24 / 24 PASS**             |
| Approval Workbench validator | **33 / 33 PASS**             |
| Adversarial validator        | **49 / 49 PASS**             |
| Recovery validator           | 20 / 21, 1 SKIP — PARTIAL    |

## What unblocks both gates

One change, by an operator with Keycloak administration, on
`trustos-foundation-validator` in `trustos-dev`:

1. **Client authentication → On**
2. **Service accounts roles → On**
3. Standard flow → Off, Direct access grants → Off
4. A dedicated audience mapper emitting **`trustos-api`**

Then the secret, without it passing through a transcript:

```bash
read -rs SECRET \
  && printf '%s' "$SECRET" \
  | railway variable set --stdin TRUSTOS_VALIDATION_CLIENT_SECRET \
      -s governance-tool -e dev --skip-deploys \
  && unset SECRET
```

The check that it worked is a one-liner: the same client-credentials request that returns
`unauthorized_client` today should return `invalid_client` for a wrong secret once the
client is confidential.
