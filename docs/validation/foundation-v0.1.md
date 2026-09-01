# TrustOS Core Foundation v0.1 — validation evidence

|                       |                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------ |
| **Status**            | **NOT VALIDATED** — Authentication is PARTIAL, so the promotion condition is not met |
| **Commit**            | `a77b4d788694fd9ceae2683afad0370c6918e3b7`                                           |
| **Branch**            | `foundation/phase-1`                                                                 |
| **Environment**       | DEV                                                                                  |
| **DEV URL**           | https://governance-tool-dev.up.railway.app                                           |
| **Identity provider** | https://id.cambobia.com                                                              |
| **DEV realm**         | `trustos-dev`                                                                        |
| **DEV identity mode** | `oidc` (runtime-confirmed)                                                           |
| **Generated**         | 2026-08-29                                                                           |

Promotion requires all seven controls PASS. Six are PASS. Authentication is PARTIAL
because the DEV validation client is not yet able to issue a machine token, so no
genuine token has been accepted by the deployed runtime. Nothing is being promoted on
adjacent evidence.

## Foundation matrix

| Control            | Result      | Evidence                                                                                                                                                   |
| ------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authentication** | **PARTIAL** | Deployed negative path proven in full; positive path not reached. See below and [step-1c-authentication.md](step-1c-authentication.md)                     |
| **Multi-tenancy**  | **PASS**    | 5 checks against the DEV database, both directions, read-by-id, and a foreign checker refused at the engine — [step-1-foundation.md](step-1-foundation.md) |
| **RBAC**           | **PASS**    | Maker refused approval, viewer refused approval, checker allowed — the negative half driven, not assumed                                                   |
| **Policy**         | **PASS**    | Every refusal produced a security event naming its reason: `self_approval_forbidden`, `transition_permission_missing`                                      |
| **Workflow**       | **PASS**    | Five states traversed and persisted; instance pinned to its own definition version across a runtime restart                                                |
| **Maker-checker**  | **PASS**    | `self_approval_forbidden` at the eligibility check _and_ in the engine's event stream                                                                      |
| **Audit**          | **PASS**    | Trail enumerated: 3 records, each naming an actor or the system, all tenant-scoped; append-only enforced by a database trigger                             |

Approval Workbench remains **NOT_IMPLEMENTED** and is excluded from the seven-control
verdict by design. It is a descriptor with no queue, detail view or service, and nothing
in this run tested it.

## Method

- **Foundation controls** — `npm run validate:foundation` against the real DEV Postgres,
  driving one User Access Change Request end to end through the framework's own
  `CHANGE_REQUEST_APPROVAL` definition. 24/24 checks passed. Every result is computed
  from what the call did; there is no `PASS` constant in the script.
- **Deployed surface** — `npm run validate -- --deployed` against DEV.
- **Authentication negatives** — tokens minted locally with an unpublished RS256 key and
  sent to the deployed runtime; rejection reasons read from the service's own logs.
- **Regression** — full suite, lint, typecheck and build.

## Test totals

|                      |                                                                          |
| -------------------- | ------------------------------------------------------------------------ |
| Tests                | **5,698 / 5,698 passing**, 1,519 suites, 0 failing                       |
| Lint                 | **0 errors** (76 warnings, all pre-existing `no-console` in CLI scripts) |
| Typecheck / build    | **passes** (`npm run build`, exit 0)                                     |
| Foundation validator | **24 / 24** against the DEV database                                     |
| Deployed validator   | 11 PASS, 4 SKIP (`NOT_REACHED`), 0 FAIL                                  |

The baseline entering this task was 5,697. The extra test covers an account with no local
password.

## Authentication — exactly what is and is not proven

Proven on the deployed DEV runtime, with no credential required:

| Check                                         | Result | Evidence                                                                                                          |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| Anonymous request refused                     | PASS   | 401 in **1.72ms** — refused at the guard, no crypto, no network                                                   |
| Malformed bearer refused                      | PASS   | 401, `reason="oidc_token_rejected"`                                                                               |
| Structurally valid JWT, unpublished key       | PASS   | 401, `reason="oidc_token_rejected"`, **39.75ms** — a JWKS lookup actually happened                                |
| Runtime uses OIDC, not local                  | PASS   | Startup record: `identityProviders:["oidc"]`; no login or password route exists on the service                    |
| No OIDC → local fallback                      | PASS   | Every unverifiable token yields 401; there is no credential path to fall back to                                  |
| Invalid-token flood does not poison readiness | PASS   | 40 invalid tokens (unknown `kid`, expired, malformed, `alg=none`) → all 401, `/ready` unchanged at `identity: ok` |
| Readiness discloses nothing                   | PASS   | Detail is `"token verification available"` — no issuer, no key state, no counters                                 |

The 1.72ms-versus-39.75ms gap is the substantive evidence: an anonymous request never
reaches token verification, while a well-formed token causes a real signature check
against the realm's published keys.

Not proven, and therefore not claimed:

| Check                                      | Status      | Why                                                                                                                                                                                                      |
| ------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Genuine machine token obtained             | NOT_REACHED | The DEV validation client cannot issue one — see below                                                                                                                                                   |
| Deployed runtime accepts a genuine token   | NOT_REACHED | Requires the above                                                                                                                                                                                       |
| Service actor resolves                     | NOT_REACHED | Requires the above                                                                                                                                                                                       |
| Expired token rejected _for being expired_ | NOT_REACHED | The expired token sent was signed by an unpublished key, so it was refused at key resolution in ~4.5ms — before expiry was ever evaluated. It was denied, but that does not demonstrate the expiry check |
| Wrong issuer rejected _for its issuer_     | NOT_REACHED | Same: refused at key resolution, not at the issuer check                                                                                                                                                 |
| Wrong audience rejected _for its audience_ | NOT_REACHED | Same                                                                                                                                                                                                     |

Isolating those three requires a token this realm actually signed. They are covered by 28
unit tests over the OIDC provider, each sabotage-verified — disabling the `azp` check or
the issuer check fails the test that covers it — but unit evidence is not deployed
evidence and is not being promoted to it.

## The blocking prerequisite

`trustos-foundation-validator` exists in `trustos-dev` and is still a **public** client.
A deliberately wrong secret returns `unauthorized_client` rather than `invalid_client`,
which is what Keycloak says about a client it can find but that cannot present a secret.

Required, in the Admin Console, on that client:

1. Client authentication → **On**
2. Service accounts roles → **On**
3. Standard flow → **Off**, Direct access grants → **Off**
4. A dedicated audience mapper emitting **`trustos-api`**

DEV already accepts `azp=trustos-foundation-validator` via `OIDC_ADDITIONAL_AUDIENCES`.

The secret must not pass through a transcript. Set it directly:

```bash
read -rs SECRET \
  && printf '%s' "$SECRET" \
  | railway variable set --stdin TRUSTOS_VALIDATION_CLIENT_SECRET \
      -s governance-tool -e dev --skip-deploys \
  && unset SECRET
```

## Known limitations

- `trustos-web` does not exist in `trustos-dev`, so browser SSO to the DEV portal does
  not work. Machine-token validation does not require it; provisioning it is the next
  identity task.
- `trustos-uat` exists with no clients. It is deliberately untouched and will receive its
  own clients and credentials — never DEV's.
- The Railway environment named `production` carries `TRUSTOS_ENVIRONMENT=dev`. Not
  remediated here; see [findings](../findings/2026-08-29-prod-environment-mislabelled.md).
- A Resend API key requires rotation; see
  [findings](../findings/2026-08-29-rotate-resend-api-key.md).

## Meaning of a future VALIDATED status

Should Authentication reach PASS, the resulting status would read _TrustOS Core Foundation
v0.1 — VALIDATED — DEV_, meaning only that the core foundation has trustworthy validation
evidence in DEV. It would not mean production ready, banking production certified, UAT
validated, or regulatory approved.
