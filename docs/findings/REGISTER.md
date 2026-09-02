# Known findings register

Every finding carries evidence and a status. A finding is closed only when something
observable changed — not when it was discussed, and not because a later run was green.

**Two status words were added on 1 September 2026**, because the existing ones were being
made to carry meanings they do not have:

- **WITHDRAWN** — the thing the finding was about no longer exists. Not fixed. Nothing was
  remediated; the scope went away. Kept rather than deleted so the record does not imply the
  problem was solved.
- **DEPLOYED** — the fix is running in the only environment there is. This exists because
  **CLOSED turned out to mean "closed on a branch"** (see TOS-019), which is not what a reader
  of this register would assume.

| ID                                                    | Title                                                             | Severity     | Environment | Status                        |
| ----------------------------------------------------- | ----------------------------------------------------------------- | ------------ | ----------- | ----------------------------- |
| [TOS-001](2026-08-29-prod-environment-mislabelled.md) | Environment mislabelled as `dev` on all seven services            | **HIGH**     | production  | **FIXED**                     |
| [TOS-002](2026-08-29-rotate-resend-api-key.md)        | Resend API key passed through a transcript                        | MEDIUM       | all         | **OPEN**                      |
| TOS-003                                               | DEV validation client is public; machine authentication unproven  | **HIGH**     | dev         | **WITHDRAWN**                 |
| TOS-004                                               | `trustos-web` accepts no redirect URI; no browser SSO             | MEDIUM       | dev         | **WITHDRAWN**                 |
| TOS-005                                               | UAT has no identity configuration and no clients                  | MEDIUM       | uat         | **WITHDRAWN**                 |
| TOS-006                                               | Merging to `main` deploys PROD with no promotion gate             | **HIGH**     | pipeline    | **CORRECTED — premise false** |
| TOS-007                                               | No immutable artifact promotion between environments              | MEDIUM       | pipeline    | **OPEN — restated, worse**    |
| TOS-008                                               | No platform-level backup identified or exercised                  | MEDIUM       | production  | **OPEN — escalated**          |
| TOS-009                                               | Approval decision and state change are not one transaction        | LOW          | all         | **OPEN (accepted)**           |
| TOS-010                                               | Deployed runtime disclosed `X-Powered-By: Express`                | LOW          | production  | **DEPLOYED**                  |
| TOS-011                                               | Invalid caller tokens marked identity unhealthy (DoS)             | **CRITICAL** | all         | **CLOSED — never shipped**    |
| TOS-012                                               | Approval detail queried an audit entity type nothing writes       | MEDIUM       | all         | **DEPLOYED**                  |
| TOS-013                                               | Local provider reached the hasher with a null password hash       | MEDIUM       | all         | **DEPLOYED**                  |
| TOS-014                                               | Validation evidence never reached the runtime                     | MEDIUM       | all         | **PARTIAL**                   |
| TOS-015                                               | Keycloak administrator credential in Railway is stale             | **HIGH**     | all         | **OPEN**                      |
| TOS-016                                               | `/health` publishes `NODE_ENV` under a field named `environment`  | LOW          | all         | **OPEN**                      |
| TOS-017                                               | Deployed services have no deploy-time migration step              | MEDIUM       | production  | **OPEN**                      |
| TOS-018                                               | Console seed fabricated a security review date                    | MEDIUM       | production  | **DEPLOYED**                  |
| TOS-019                                               | CLOSED meant closed on a branch; production ran 46 commits behind | **HIGH**     | process     | **FIXED — process gap open**  |
| TOS-020                                               | Application catalog was in memory; registrations lost on restart  | MEDIUM       | all         | **DEPLOYED**                  |

---

## Deployment gap — resolved 2 September 2026

**TOS-018 and TOS-020 are now running in production.** They were recorded as
`FIXED — not deployed` for a day, deliberately: TOS-019 exists because this register once said
CLOSED when it meant "closed on a branch", and the same error was available to make again.

Production could not take the commits until `20261216000000_internal_application_catalog` was
applied — `PersistentAppCatalog` reads a table that did not exist, so deploying first would have
crash-looped the gateway on boot. The order was migrate, then deploy, and it was not automated,
which is TOS-017.

**How it was done.** The migration ran through `.github/workflows/migrate.yml` rather than from a
workstation. The first attempt failed and applied nothing: `prisma migrate status` exits 1
whenever migrations are pending — it is a check command — so an informational step killed the job
before `Apply`. Worth recording because it failed _closed_. `Status before` now tolerates that
exit; `Status after` stays strict, so its success is the evidence the database is in sync rather
than merely that a command ran.

The deploy was staged: `governance-tool` alone first, since it carries the code that needs the new
table, gated on `/ready` returning 200 before the other six were touched. It returned 200 after
135s; the remaining six followed and were on new code 20s later.

**Verified from the running system, not from a green tick:**

```
trustosEnvironment="prod"  registeredResources=0  appCatalog="database"
seeded=10   withheld=["risk-compliance-console"]
```

`appCatalog="database"` is TOS-020. `withheld=["risk-compliance-console"]` is TOS-018 — the one
highly-restricted console, no longer registered in production on a fabricated review date, with
the other ten seeded into the new table.

`registeredResources=0` is unchanged and correct. Production still refuses every read, because no
data source has an owner and a separate approver. That is the honest state, and it is the half of
TOS-020 that no one reading this repository can fix.

## Scope change — 1 September 2026

**DEV and UAT were deleted** to reduce cost. Production is now the only environment.

Sixteen of twenty-six running service instances were removed, along with both non-production
Postgres volumes. This was a deliberate decision taken with the consequences stated, not an
incident.

It is recorded here because five findings in this register were scoped to environments that no
longer exist. **None of them were fixed.** Deleting the environment a finding describes does not
remediate it, and the register would be misleading if those rows read CLOSED. They read
WITHDRAWN.

What the deletion did **not** remove:

- **The `trustos-dev` realm inside Keycloak.** Keycloak runs as a _production_ service, so its
  realms survived. Cleaning them up needs the credential from TOS-015 and has not been done.
- **TOS-015 itself**, for the same reason.
- **The risk TOS-006 and TOS-007 describe.** With no environment below production, there is
  nothing left to rehearse a change in. The pipeline findings did not shrink; their consequences
  now land in one place.

---

## TOS-003 — DEV validation client is public

> **WITHDRAWN — 1 September 2026. Not fixed.** The DEV environment was deleted, so the client
> this finding is about no longer has an environment to authenticate to. Nothing was remediated:
> the client was still refusing the grant when the environment was removed, and it was re-tested
> and still failing on 31 August. The `trustos-foundation-validator` client itself **still exists**
> inside the production Keycloak's `trustos-dev` realm, because Keycloak is a production service
> and its realms survived the deletion. Cleaning that up is owed and needs TOS-015.
>
> Everything below is the record as it stood.

**Severity** HIGH · **Environment** dev · **Status** OPEN · **Owner** operator with Keycloak administration

**Re-verified a third time on 2026-08-31 and still open**, with the same
`unauthorized_client`. The automated remediation was attempted on that date and could not
start: the Keycloak administrator credential held in Railway is refused — **TOS-015**.
Until that credential is recovered, this finding cannot be closed through the admin API,
only by hand in the Admin Console.

**Re-verified twice on 2026-08-29 and still open.** After the operator reported setting
Client authentication ON and Service accounts ON in the Admin Console, the token endpoint
was re-tested rather than trusted: it still answers `unauthorized_client`, where a
confidential client with a wrong secret answers `invalid_client`. The client exists in
`trustos-dev` and in no other realm, so this is not a wrong-realm mistake — the change did
not take effect. Most likely the Capability config section was not saved; a confidential
client has a Credentials tab and a public one does not, which is the quickest structural
check. Re-test with `scripts/operator/check-dev-validation-client.sh`. Second attempt:
[gate-1-attempt-2-2026-08-29.md](../validation/releases/v0.1/gate-1-attempt-2-2026-08-29.md).

**First verification, 2026-08-29.** The client-credentials flow returns
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

> **CORRECTED — 1 September 2026. The premise of this finding is false.**
>
> This was tested rather than reasoned about: 46 commits were merged to `main` via PR #5, and
> **production did not deploy**. No build was queued, and the service's deployment list showed
> nothing between 29 August and a build triggered by an unrelated variable change. Production
> was still serving `x-powered-by: Express` — pre-merge code — afterwards.
>
> So Railway's GitHub integration is **not** watching `main` the way this finding claims, and the
> stated consequence — "the only thing standing between a merged pull request and production is
> that nobody merges it" — is wrong.
>
> **The truth is different, not milder.** Production updates only when a person runs
> `railway up` from a working tree by hand. There is no gate _and_ no automation: a merge to
> `main` changes nothing in production, so the repository's default branch and the running
> system drift silently apart. That is what actually happened, and it is TOS-019.
>
> Severity stays HIGH and the finding stays open, for a different reason than it was raised.

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

> **RESTATED — 1 September 2026. More true than when written, not less.**
>
> This finding said each environment builds its own image, so DEV evidence describes _a_ build
> rather than _the_ build. With DEV and UAT deleted there is nothing left to promote — which
> removes the comparison, not the problem.
>
> Production is now deployed by `railway up` from a working tree, which is precisely the
> mechanism this finding objected to, and it is now the _only_ mechanism. The bytes running in
> production correspond to whatever was on one machine's disk at upload time. That they matched a
> commit on 1 September was verified by hand, not enforced by anything.

**Severity** MEDIUM · **Environment** pipeline · **Status** OPEN

Each environment builds its own image from its own source: DEV was deployed in this work
by `railway up` from a working tree, while PROD builds from `main` through the Railway
GitHub integration. Both use `railway.json`'s `dockerfilePath`, but nothing guarantees
the bytes DEV validated are the bytes UAT or PROD would run.

**Consequence.** Validation evidence gathered in DEV describes a build, not _the_ build.
This is why DEV evidence is not promoted across environments anywhere in this repository.

---

## TOS-008 — No platform-level backup identified for DEV

> **ESCALATED and RE-SCOPED to production — 1 September 2026.**
>
> This was scoped to DEV, where the consequence of an unproven restore was an inconvenience. DEV
> is gone. The finding now applies to production, which holds the real data and is the only
> environment there is, and where an unproven restore is the whole business.
>
> Nothing about production's backup posture has been established. The measurements below were
> taken against the DEV database, which no longer exists, so they are no longer evidence of
> anything about the running system.
>
> The blocker recorded below still holds: the local `pg_dump` is 14.18 against a server on 18.6.

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

> **WITHDRAWN — 1 September 2026. Not fixed.** As with TOS-003: the DEV environment is gone, the
> client remains in the surviving `trustos-dev` realm, and browser SSO was never made to work.
> The remediation script could never run, because TOS-015 blocked it from the day it was written.

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

`scripts/operator/configure-dev-validation-client.sh` already performs exactly that, in
step 3. It has not been able to run since the administrator credential stopped working —
**TOS-015** blocks this finding for the same reason it blocks TOS-003.

---

## TOS-014 — validation evidence never reached the runtime

> **STILL PARTIAL — 1 September 2026, and its blocker changed.**
>
> The packaging fix is now genuinely deployed: production ran 46 commits behind until today, so
> until the merge the compiled evidence module was not in production **at all** (see TOS-019).
> It is now, and the start-up banner reports it.
>
> An earlier claim in this session that production was serving DEV's evidence as its own PASS was
> **wrong**, and is corrected here: production did not have the evidence feature at all, so there
> was no false green. The environment isolation rule was never defeated.
>
> What is still not reached: the registry _value_ read through the deployed API. The blocker used
> to be TOS-003; with DEV deleted it is now that production's own API requires authentication that
> nobody can provision, which is TOS-015.

**Severity** MEDIUM · **Environment** all · **Status** PARTIAL · **Fixed in** `afc9359`

### Root cause

The application registry resolved validation status from
`docs/validation/application-evidence.json`, read at start-up from the working directory.
The runtime image copies `node_modules`, `packages`, `apps` and `package.json` — not
`docs`. The file was therefore never present in a deployed environment, every application
reported `not_tested`, and the feature did nothing precisely where it was for.

It failed in the safe direction, which is why it was not misleading, and it is why it
survived review: on a developer machine the docs tree is present and the happy path works.

### Fix

Evidence is a module under `packages/governance-tool-core/src/recorded-evidence.ts`,
generated by the validation suite and committed. It ships wherever the application ships,
needs no filesystem access, and is type-checked. Human documentation under `docs/` is
retained and is no longer load-bearing.

The catalog additionally returns provenance beside the status — commit, suite,
environment, counts — under the same environment rule as the status itself.

### Evidence

| Requirement                                    | Result                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Root cause demonstrated                        | yes — Dockerfile copies no `docs/`; deployed container logged the absence                               |
| Runtime artifact exists                        | yes — `recorded-evidence.ts`, generated, 1,314 bytes                                                    |
| Included in runtime packaging                  | yes — compiled to `dist/`, which the image copies; asserted by test                                     |
| Runtime uses it                                | yes — DEV start-up reports `validationEvidence={"records":1,"applications":["approval-workbench@dev"]}` |
| Environment isolation                          | yes — DEV evidence answers `not_tested` for uat, prod and production                                    |
| Stale/failed evidence cannot leave false green | yes — failed reports `fail`, partial reports `partial`, malformed never reports `pass`                  |
| Regression test exists                         | yes — 22 tests, sabotage-verified three ways                                                            |
| Build and tests pass                           | yes — 5,756/5,756, format/lint/build clean                                                              |

### Why PARTIAL rather than CLOSED

The registry **value** has not been read through the deployed API. `GET
/api/governance/apps` requires authentication and returns 401, because the DEV validation
client is still public — **TOS-003**. So "Approval Workbench reports PASS in DEV over
HTTP" is NOT_REACHED.

That gap is not in this fix. The packaging defect is demonstrably repaired: the runtime
now carries evidence it previously could not reach, and says so at start-up. This closes
when TOS-003 does and the value can be read.

### A correction worth recording

The first attempt at deployed proof observed that the "no application validation evidence
found" warning had stopped appearing. That was not evidence — the function emitting it had
been deleted, so its absence proved the code had changed and nothing more. The runtime now
states what it carries positively, and the proof is an observation rather than an inferred
absence.

---

## TOS-015 — Keycloak administrator credential in Railway is stale

**Severity** HIGH · **Environment** all · **Status** OPEN · **Owner** whoever rotated the
administrator password

### What was observed

On 2026-08-31 the remediation for TOS-003 was attempted with
`scripts/operator/configure-dev-validation-client.sh`. It never reached Keycloak's admin
API. The credential the script reads from the Railway `keycloak` service — a 13-character
username and a 28-character password, both present and non-empty — is refused by the
master realm's token endpoint:

```
error: invalid_grant
description: Invalid user credentials
```

The variables are not missing or truncated. They are simply wrong.

### Why

`KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` are _bootstrap_ values.
Keycloak consults them only when a realm starts for the first time with no administrator
present; it does not read them again afterwards, and rotating the password through the
Admin Console does not write back to them. The Railway variables therefore record what
the password was on first boot, not what it is. The working password exists only wherever
it was rotated to, which is not in this project's infrastructure.

The `keycloak` service holds no other administrator credential — only `KC_BOOTSTRAP_ADMIN_*`
and the `KC_DB_*` set.

### Consequence

There is no working break-glass administrator for the identity provider. This is not a DEV
inconvenience: the same instance at `id.cambobia.com` serves the production `trustos`
realm alongside `trustos-dev`. Nothing can be configured, audited, recovered or revoked
through the admin API by anyone reading from the recorded credential.

Concretely, it blocks two open findings that were otherwise ready to fix, since the script
that fixes both cannot authenticate: **TOS-003** (steps 1, 2 and 4) and **TOS-004** (step 3).

### What was done about it

The script no longer depends on the stale variable alone. It now seeks the credential in
the environment (`KC_ADMIN_USERNAME` / `KC_ADMIN_PASSWORD`), then on the Railway service,
then at an interactive `read -rs` prompt when run in a terminal — three attempts, then it
stops rather than walk the account into a lockout policy. Whichever source answers, the
value is never echoed, never written to a file, and never passed as an argument, which is
the constraint TOS-002 exists to enforce.

Verified on 2026-08-31: the environment path and the prompt path both reach Keycloak and
report `invalid_grant` for a deliberately wrong credential; a non-interactive run skips
the prompt and exits 1. In every case the script stops before the first write, so nothing
in either realm was changed by any of this.

That is a workaround for the operator, not a fix for the finding.

### Remediation

1. Recover the working administrator password from wherever it was rotated to, and run
   the script with it — the prompt is there for precisely this.
2. Then repair the break-glass path properly: put a current administrator credential in
   the secret store the team actually uses, and stop treating `KC_BOOTSTRAP_ADMIN_*` as
   a live credential. It is a first-boot artifact and will drift again the next time
   anyone rotates.
3. If the password cannot be recovered at all, a new administrator must be minted against
   the running instance (`kc.sh bootstrap-admin user`), which needs shell access to the
   `keycloak` service. That was not attempted here.

**Evidence** the run recorded above; reproduce with
`bash scripts/operator/configure-dev-validation-client.sh`, which fails closed.

---

## TOS-005 — UAT had no identity configuration

**Severity** MEDIUM · **Environment** uat · **Status** WITHDRAWN · **Raised** 2026-08-29

The UAT environment had no identity configuration and no clients, so nothing could authenticate
against it.

**Withdrawn on 1 September 2026 because UAT was deleted, not because it was fixed.** Worth
recording what it cost: all eight UAT services were running and being billed for the entire
period this finding was open. An environment that could not authenticate anybody was consuming
the same resources as one that could. That is the clearest waste this register found, and it was
found by asking what was running rather than what was configured.

---

## TOS-016 — `/health` publishes `NODE_ENV` under a field named `environment`

**Severity** LOW · **Environment** all · **Status** OPEN

`GET /health` returns `"environment": "production"` on every service, in every environment. That
value is `NODE_ENV`, taken from `config.env` in `packages/config/src/config.ts`. It is _correct_ —
a UAT or DEV gateway legitimately runs `NODE_ENV=production` — but the field is named
`environment`, and the platform's actual environment identity is `TRUSTOS_ENVIRONMENT`.

The codebase is explicit that these must not be conflated, in a comment on the very function that
reads the other one:

> `TRUSTOS_ENVIRONMENT` rather than `NODE_ENV`: a UAT gateway runs with `NODE_ENV=production`
> because that is what turns on production behaviour in the runtime, and conflating the two is
> how a UAT instance ends up believing it is production or the reverse.

The one endpoint an operator or an uptime monitor actually reads publishes the conflated value.
The start-up log gets this right — it reports `env="production"` and `trustosEnvironment="prod"`
as separate fields. `/health` does not.

**How it misled, concretely.** During the DEV work on 31 August, `/health` on the DEV service
reported `"environment":"production"`. That was read as a possible recurrence of TOS-001 and cost
a detour to disprove.

**Remediation.** Report both, named for what they are: `nodeEnv` and `environment`, the latter
from `TRUSTOS_ENVIRONMENT`. A field called `environment` should answer the question its name asks.

---

## TOS-017 — Deployed services have no deploy-time migration step

**Severity** MEDIUM · **Environment** production · **Status** OPEN

The root `railway.json` — the one every deployed service builds through — has no
`preDeployCommand`. The image's `CMD` is `node apps/${SERVICE}/dist/main.js` and nothing else.
So a deploy starts new code against whatever schema the database already has.

The repository knows the pattern. Both of these have it:

- `apps/api-example/railway.json` → `"preDeployCommand": "npm run db:deploy"`
- `templates/saas-starter/railway.json` → the same

The services that actually run do not.

**What made this visible rather than theoretical.** Before merging 46 commits containing the
`20261215000000_external_identity` migration, production's schema was checked with
`prisma migrate status`. It answered `Database schema is up to date!` — all ten migrations
applied. Production was current because somebody had run them by hand, not because anything
enforced it.

**Consequence.** The next migration merged and deployed will run code against an unmigrated
database. Prisma fails such queries at runtime (`P2022`), so the failure mode is a service that
starts, passes its health check — `/health` touches no dependency by design — and then refuses
real requests.

**Remediation — and a correction to the first version of this finding.**

This finding originally said to copy `"preDeployCommand": "npm run db:deploy"` from the examples.
**That does not work for these services, and the recommendation was wrong.** The Dockerfile runs
`npm prune --omit=dev` after building, and the `prisma` CLI is a devDependency of
`@trustsystem/database` — no package declares it as a runtime dependency. A `preDeployCommand`
invoking it in the deployed image fails with `prisma: not found`. The examples get away with the
pattern because they are not built by this Dockerfile.

Two options that actually work:

1. **Migrate from CI**, in a workflow that has the full toolchain, before the deploy. This also
   puts the migration under review and gives it a log, and it is the same reasoning that moved
   package publishing off a laptop. **Built:** `.github/workflows/migrate.yml`. It needs one
   secret — `DATABASE_URL`, set to the target's `DATABASE_PUBLIC_URL`, because a runner cannot
   reach `postgres.railway.internal`. It reports status before and after, and it does not deploy
   code: the ordering stays explicit rather than implied.
2. **Promote `prisma` to a runtime dependency** of `@trustsystem/database` so the CLI survives
   pruning, then add the `preDeployCommand`. Simpler, at the cost of the CLI and its engines in
   every runtime image.

Either way, Railway is retiring `railway.json` in favour of `.railway/railway.ts` on
**1 December 2026**, so option 2 lands twice unless that migration is done first.

---

## TOS-018 — The console seed fabricated a security review date

**Severity** MEDIUM · **Environment** production · **Status** FIXED · **Fixed in** `3f7ba9c`

`internalApplicationSchema` refuses a `highly_restricted` application in production that has
never had a security review — the classification is the reason the review is required. The seed
satisfied that check by stamping a constant:

```ts
lastSecurityReview: environment === 'prod' ? '2026-01-01T00:00:00.000Z' : null,
```

So `risk-compliance-console`, the one highly-restricted console, passed a governance control in
production on the strength of a hardcoded date in library code. No such review took place.

**This is the same shape as TOS-014**: a control that reports a fact it does not have. It failed
in the _unsafe_ direction, which TOS-014 did not — a fabricated pass is worse than a false
`not_tested`.

It was hiding in plain sight. The function's own docstring said a deployment "records a real
review date rather than inheriting a placeholder from here" — describing the correct behaviour
while implementing the opposite, with nothing to make the first sentence true.

**Fix.** No date is invented. A template that cannot be registered honestly is withheld, and
`templatesWithheldFrom(environment)` names which; the gateway warns at start-up, because a
console that quietly fails to appear is indistinguishable from one nobody asked for. Reinstating
the placeholder fails two tests.

**Consequence of the fix, stated plainly.** `risk-compliance-console` is no longer registered in
production. That is a real reduction in what production serves. The route back is a recorded
review date, not a re-added constant.

---

## TOS-019 — CLOSED meant closed on a branch

**Severity** HIGH · **Environment** process · **Status** FIXED for the backlog; the gap that
caused it is OPEN

On 1 September 2026 production was found to be running `main` at `7b6ab71` — **46 commits
behind** `foundation/phase-1`. Every fix behind every CLOSED row in this register lived only on
the branch. This register said CLOSED; production had none of them.

**Proven by observation, not by reading commits.** `trustos.cambobia.com` was serving
`x-powered-by: Express` — TOS-010, recorded CLOSED since 29 August, live in production.
Independently: `main` contained no `recorded-evidence.ts`, production's `/ready` had no identity
indicator, and its start-up banner had no `validationEvidence` field.

**One correction the same check produced.** TOS-011 is CRITICAL and was also branch-only — but
`main` had no identity health-marking code at all, so the DoS never existed in production. That
bug was introduced _and_ fixed inside the branch. A CRITICAL finding that never shipped is a
materially different thing from one that shipped and was fixed, and the register did not
distinguish them. It does now.

**Root cause.** Two independent facts that were each individually reasonable:

1. This register recorded a fix as CLOSED when the _code_ changed, and its own opening rule —
   "closed only when something observable changed" — was satisfied by observing DEV, the
   environment the work was done in.
2. Merging to `main` does not deploy production (TOS-006, as corrected). So the branch could be
   merged, or not, without production changing either way.

Together they meant a register full of CLOSED rows describing a production environment that had
none of the fixes.

**What was done.** PR #5 was merged and all seven production services were deployed and verified
by direct observation: `x-powered-by` gone, `/ready` reporting database _and_ identity, health 200
across all seven. Statuses that mean "running in production" now read DEPLOYED.

**What is still open.** Nothing prevents this recurring. There is no automated deploy, no
non-production environment to stage in, and no check that the running system matches a commit.
The container cannot report its own commit — `recorded-evidence.ts` says so explicitly, and
carries a validated-at commit rather than pretending to verify it. Until a deploy is triggered by
a merge, or a version endpoint reports the running commit, "is production current?" stays a
question answered by hand.

---

## TOS-020 — The application catalog was in memory

**Severity** MEDIUM · **Environment** all · **Status** FIXED · **Fixed in** `06062cb`

Production's start-up log said it, unprompted, on every boot:

```
[WARN] The internal application catalog is in memory. Applications created here are
       lost on restart
[WARN] No resources are registered. Every read will be refused with "no approved
       resource" until a deployment registers its own
```

Both were true and neither was a bug in the framework — they were a deployment that had never
been wired. Together they meant a consumer of the deployed platform was refused on every read,
and anything they created disappeared on the next deploy.

**The catalog is fixed.** An `internal_application` table now holds registrations, and
`PersistentAppCatalog` keeps reads in memory — the registration check is on every request's path
— while the table is the record. The row is written before the map, so nothing is servable that is
not also recorded; reversing that order fails three tests. A stored definition that no longer
validates is refused and named rather than trusted, and one bad row does not stop the gateway
serving the others. A single replica is a documented precondition, not an accident.

**The resource half is not fixed, and cannot be by anyone reading this repository.** Resources
are now declared in `apps/governance-tool/src/resource-registrations.ts` — a module the runtime
image actually contains, rather than a file under `docs/`, which is the TOS-014 mistake. Every
environment's list is **empty**, deliberately. A registration names an owner, a separate approver,
an access class and a credential reference, and the schema refuses a production resource whose
approver is its own owner: _"the registrant approved their own production resource. That is the
control, collapsed."_ Those are facts about an organisation. Filling them in with plausible values
would be a fabricated approval record — TOS-018, committed on purpose.

**So production still refuses every read**, and will until someone with the authority to approve a
data source does so. That is the honest state, and it is now visibly the honest state: the
gateway reports what it has rather than warning unconditionally, because a warning that fired
whether or not anything was registered could never be evidence of either.
