# Known findings register

Every finding carries evidence and a status. A finding is closed only when something
observable changed — not when it was discussed, and not because a later run was green.

| ID                                                    | Title                                                            | Severity     | Environment | Status              |
| ----------------------------------------------------- | ---------------------------------------------------------------- | ------------ | ----------- | ------------------- |
| [TOS-001](2026-08-29-prod-environment-mislabelled.md) | PROD identifies itself as DEV                                    | **HIGH**     | production  | **OPEN**            |
| [TOS-002](2026-08-29-rotate-resend-api-key.md)        | Resend API key passed through a transcript                       | MEDIUM       | all         | **OPEN**            |
| TOS-003                                               | DEV validation client is public; machine authentication unproven | **HIGH**     | dev         | **OPEN**            |
| TOS-004                                               | `trustos-web` not provisioned in `trustos-dev`; no browser SSO   | MEDIUM       | dev         | **OPEN**            |
| TOS-005                                               | UAT has no identity configuration and no clients                 | MEDIUM       | uat         | **OPEN**            |
| TOS-006                                               | Merging to `main` deploys PROD with no promotion gate            | **HIGH**     | pipeline    | **OPEN**            |
| TOS-007                                               | No immutable artifact promotion between environments             | MEDIUM       | pipeline    | **OPEN**            |
| TOS-008                                               | No platform-level backup identified or exercised for DEV         | MEDIUM       | dev         | **OPEN**            |
| TOS-009                                               | Approval decision and state change are not one transaction       | LOW          | all         | **OPEN (accepted)** |
| TOS-010                                               | Deployed runtime disclosed `X-Powered-By: Express`               | LOW          | dev         | **CLOSED**          |
| TOS-011                                               | Invalid caller tokens marked identity unhealthy (DoS)            | **CRITICAL** | all         | **CLOSED**          |
| TOS-012                                               | Approval detail queried an audit entity type nothing writes      | MEDIUM       | all         | **CLOSED**          |
| TOS-013                                               | Local provider reached the hasher with a null password hash      | MEDIUM       | all         | **CLOSED**          |

---

## TOS-003 — DEV validation client is public

**Severity** HIGH · **Environment** dev · **Status** OPEN · **Owner** operator with Keycloak administration

**Re-verified 2026-08-29 and still open.** The client-credentials flow returns
`401 unauthorized_client`, while a client name that does not exist returns
`invalid_client` from the same endpoint in the same run — so Keycloak resolves this client
and refuses it the grant. `TRUSTOS_VALIDATION_CLIENT_SECRET` is also still absent from the
DEV service. Evidence:
[gate-1-attempt-2026-08-29.md](../validation/releases/v0.1/gate-1-attempt-2026-08-29.md).

`trustos-foundation-validator` exists in the `trustos-dev` realm and cannot authenticate.
A deliberately wrong secret returns `unauthorized_client` rather than `invalid_client`,
which is what Keycloak says about a client it can find but that is not configured to
present a secret.

**Consequence.** No machine token can be obtained, so the deployed authenticated path is
unproven: the positive authentication case, the deployed HTTP application boundary, and
isolated expiry/issuer/audience checks all remain NOT_REACHED.

**Remediation** — Admin Console, on that client in `trustos-dev`:

1. Client authentication → **On**
2. Service accounts roles → **On**
3. Standard flow → **Off**, Direct access grants → **Off**
4. A dedicated audience mapper emitting **`trustos-api`**

Then supply the secret without it passing through a transcript:

```bash
read -rs SECRET \
  && printf '%s' "$SECRET" \
  | railway variable set --stdin TRUSTOS_VALIDATION_CLIENT_SECRET \
      -s governance-tool -e dev --skip-deploys \
  && unset SECRET
```

**Evidence** `docs/validation/releases/v0.1/README.md`, gate 1.

---

## TOS-006 — Merging to `main` deploys PROD with no promotion gate

**Severity** HIGH · **Environment** pipeline · **Status** OPEN

GitHub Actions contains one workflow, `ci.yml`, triggered on `push: [main]` and
`pull_request: [main]`. It references no secrets, holds no `RAILWAY_TOKEN`, and has no
deployment step — every `DATABASE_URL` in it points at an ephemeral `localhost` service
container. **Opening a pull request therefore cannot deploy anything**, which is what
made it safe to open one during this work.

The coupling is outside GitHub Actions: Railway's own GitHub integration watches `main`,
so a merge deploys production directly. There is no approval step, no artifact gate and
no UAT stage between the two.

**Consequence.** The only thing standing between a merged pull request and production is
that nobody merges it. That is a convention, not a control.

**Recommended remediation** — separate CI from deployment: build once, deploy that
artifact to DEV, promote the same artifact to UAT, and require an explicit approval for
PROD. Not attempted here; redesigning the pipeline was out of scope.

---

## TOS-007 — No immutable artifact promotion

**Severity** MEDIUM · **Environment** pipeline · **Status** OPEN

Each environment builds its own image from its own source: DEV was deployed in this work
by `railway up` from a working tree, while PROD builds from `main` through the Railway
GitHub integration. Both use `railway.json`'s `dockerfilePath`, but nothing guarantees
the bytes DEV validated are the bytes UAT or PROD would run.

**Consequence.** Validation evidence gathered in DEV describes a build, not _the_ build.
This is why DEV evidence is not promoted across environments anywhere in this repository.

---

## TOS-008 — No platform-level backup identified for DEV

**Severity** MEDIUM · **Environment** dev · **Status** OPEN

The Railway Postgres service exposes no backup-related variables, and no platform
snapshot mechanism was identified from the tooling available. A native `pg_dump` could
not be exercised either: the server is PostgreSQL 18.6 and the only client available is
14.18, which refuses on version mismatch, with no container runtime to borrow a matching
client from.

**What was proven instead.** Logical backup and restore of the domain data: 30 rows
exported, restored into an isolated schema, verified table by table, and read back
through the domain with the fields a reviewer acts on compared field for field. Backup
850–1052ms, restore 2318–3208ms. Those are measurements, not an RTO.

**Remediation.** Identify the platform snapshot mechanism, exercise a restore from it
into an isolated database, and measure. `"Backup configured"` is not evidence.

---

## TOS-009 — Approval decision and state change are not one transaction

**Severity** LOW · **Environment** all · **Status** OPEN, accepted

`WorkflowEngine.transitionInternal` records the decision, then updates the instance, then
writes history, then completes the task. There is no enclosing database transaction.

**What that means, precisely.** The reachable inconsistency is _decision recorded, state
unchanged_. The dangerous direction — a request showing approved with no decision behind
it — cannot occur, because the decision is written first. Validated against the live DEV
database: every approved instance had at least one decision.

A retry on a healthy runtime converges: the engine re-reads the step's decisions before
evaluating approval, so the second attempt advances the state without recording a second
decision. Measured: 0 decisions after an injected write failure, 1 after retry, final
state `approved`.

**Why it is accepted rather than fixed.** The failure window is small, the surviving
state is recoverable by retry, and wrapping the transition in a transaction would pull
the audit sink and task store into the same transaction boundary — a larger change than
the risk warrants. Recorded so the choice is visible rather than assumed.

---

## TOS-004 — `trustos-web` exists but accepts no redirect URI

**Severity** MEDIUM · **Environment** dev · **Status** OPEN, progressed

The client has been created in `trustos-dev` since the last run — the authorization
endpoint now answers for it rather than saying `Client not found`. It is not yet usable:
every redirect URI tried was refused with `Invalid parameter: redirect_uri`, including
`https://governance-tool-dev.up.railway.app/` and `https://trustos.cambobia.com/`.

**Consequence.** Browser sign-in to the DEV portal still does not work. This does not
block the machine-token path, which is TOS-003.

**Remediation.** Add the DEV portal's redirect URI and web origin to the client, and
confirm it is public with PKCE (S256) rather than confidential — the portal is a browser
client and holds no secret.
