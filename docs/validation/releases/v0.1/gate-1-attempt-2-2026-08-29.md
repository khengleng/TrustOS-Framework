# Gate 1 closure — second attempt, after the operator reconfigured the client

|             |                                                 |
| ----------- | ----------------------------------------------- |
| Commit      | `1c52646ccf4a25e15b05e0a830e42b23d4238985`      |
| Environment | DEV                                             |
| Realm       | `trustos-dev`                                   |
| **Result**  | **KEYCLOAK_CLIENT_CONFIGURATION_NOT_EFFECTIVE** |
| **Gate 1**  | **PARTIAL** (unchanged)                         |
| **Gate 2**  | **NOT_REACHED** (unchanged)                     |

## What the operator reported

Client authentication ON · Service accounts roles ON · Standard flow OFF · Direct access
grants OFF · Implicit OFF · Authorization OFF · Client enabled ON.

## What the token endpoint does

Re-tested rather than assumed, per the instruction not to close on an observed UI.

```
POST /realms/trustos-dev/protocol/openid-connect/token
grant_type=client_credentials  client_id=trustos-foundation-validator
client_secret=<deliberately wrong probe value>

HTTP 401  unauthorized_client: Invalid client or Invalid client credentials
```

**The behaviour has not changed.** A confidential client with a wrong secret answers
`invalid_client`; this still answers `unauthorized_client`, which is what Keycloak says
about a client it can resolve but that is not permitted the grant.

### The distinction, from the same endpoint in the same run

| client_id                               | error                     |
| --------------------------------------- | ------------------------- |
| `trustos-foundation-validator`          | **`unauthorized_client`** |
| `definitely-not-a-client-xyz` (control) | `invalid_client`          |

### It is not a wrong-realm mistake

The client exists in exactly one realm, and it is the right one:

| Realm         | Client present | client_credentials    |
| ------------- | -------------- | --------------------- |
| `trustos-dev` | **present**    | `unauthorized_client` |
| `trustos`     | absent         | `invalid_client`      |
| `trustos-uat` | absent         | `invalid_client`      |
| `master`      | absent         | `invalid_client`      |

So the change was made against the right client in the right realm, and did not take
effect on the token endpoint.

## Most likely cause

The Capability config section was not saved. Keycloak's client Settings page has its own
Save button below Capability config, and toggles left unsaved still show as set until the
page is reloaded.

**The fastest confirmation is structural rather than visual: a confidential client has a
Credentials tab; a public one does not.** If `trustos-dev → Clients →
trustos-foundation-validator` shows no Credentials tab beside Settings, Client
authentication is still off whatever the toggle displays.

## Re-checking without an administrator credential

```bash
bash scripts/operator/check-dev-validation-client.sh
```

One token request with a deliberately wrong secret; nothing is changed and nothing
sensitive is printed. `invalid_client` means configured, `unauthorized_client` means not
yet.

## Tasks not reached, and why

| Task                                 | Status                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| 2 — audience mapper                  | **NOT_REACHED** — cannot be observed without a token, and no admin API access |
| 3 — client secret                    | **ABSENT** from the DEV service                                               |
| 4 — client credentials positive path | **NOT_REACHED**                                                               |
| 5 — protected endpoint               | **NOT_REACHED**                                                               |
| 8 — foundation closure               | Authentication stays **PARTIAL**; six controls unchanged at PASS              |
| 9–18 — Gate 2 HTTP boundary          | **NOT_REACHED** — gated on Gate 1                                             |

No TrustOS code was changed, per task 1.

## Findings

**TOS-003 stays OPEN.** The instruction is explicit that it closes only when
client-credentials succeeds and the deployed positive path is proven. Neither has
happened. It is not downgraded on the strength of a console observation.
