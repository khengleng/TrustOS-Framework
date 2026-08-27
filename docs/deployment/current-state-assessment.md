# Current state assessment

Written before any deployment change was made, as the readiness specification requires. It records
what the repository is today, what needs to run, what must never become a service, and what is
missing.

## What the repository contains

|                          | Count                  |
| ------------------------ | ---------------------- |
| Packages (`packages/`)   | 171                    |
| Applications (`apps/`)   | 11                     |
| Templates (`templates/`) | 24                     |
| Prisma migrations        | 9                      |
| Tests                    | 5,490 across 220 files |

## The critical distinction: libraries and services

**168 of the 171 packages are libraries.** They are compiled to `dist/`, imported by applications,
and have no process of their own. Deploying any of them as a service would be deploying a service
that does nothing.

Three packages have names that suggest otherwise and are **also libraries**:

| Package                     | Why it is not a service                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@trustos/job-runtime`      | Provides `Worker`, `Queue` and a registry. A deployment hosts the worker inside its own process; the package ships no `main`. |
| `@trustos/scheduler`        | Provides cron parsing and a scheduler class. Same shape.                                                                      |
| `@trustos/workflow-runtime` | Provides the engine and its stores. The engine runs inside whatever service advances a workflow.                              |
| `@trustos/ai-gateway`       | Provides the gateway class, provider ports and metrics. It holds no HTTP server.                                              |

This matters because the readiness specification's example topology names
`workflow-worker`, `job-worker` and `ai-gateway` as services. **Those services do not exist in this
repository**, and the specification is explicit: _if some services do not exist or are unnecessary,
do not invent them._

They are not omissions. The framework's position is that a worker is a _deployment's_ process
hosting a framework runtime, and inventing three worker applications here would be inventing three
opinions about how a deployment schedules work.

## The applications

| Application                   | Kind            | Runtime? | Notes                                                             |
| ----------------------------- | --------------- | -------- | ----------------------------------------------------------------- |
| `api-example`                 | NestJS HTTP     | **yes**  | Reference API demonstrating every package. The smoke application. |
| `internal-app-gateway`        | NestJS HTTP     | **yes**  | The single entrance every internal application calls.             |
| `governance-tool`             | NestJS HTTP     | **yes**  | The internal application catalog and console runtime.             |
| `enterprise-governance-admin` | NestJS HTTP     | **yes**  | Data governance, policy, APIs, continuity.                        |
| `sre-operations-console`      | NestJS HTTP     | **yes**  | Service health, objectives, incidents.                            |
| `api-developer-portal`        | NestJS HTTP     | **yes**  | The filtered catalog and access requests.                         |
| `financial-product-admin`     | NestJS HTTP     | **yes**  | The Financial Product Designer.                                   |
| `security-admin-example`      | NestJS HTTP     | example  | Identity, sessions, keys, service accounts.                       |
| `workflow-admin-example`      | NestJS HTTP     | example  | Definitions, instances, tasks.                                    |
| `admin-example`               | Next.js         | example  | A reference admin console.                                        |
| `merchant-wallet-basic`       | Library + tests | **no**   | The phase-14 pilot. Deliberately has no `main.ts`.                |

**Seven runtime services**, three of which are examples a deployment may or may not want, and one
pilot that is a library.

`merchant-wallet-basic` having no `main.ts` is deliberate and documented in
[`../pilot/architecture.md`](../pilot/architecture.md): three applications already demonstrate the
NestJS composition, and a fourth would have measured the guard chain again rather than measuring
anything new.

## Current deployment state

|                          | State                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Dockerfiles              | **None.** Not one, anywhere.                                                                             |
| Railway configuration    | Three `railway.json` files — `api-example`, `admin-example`, `saas-starter` — using the Railpack builder |
| `.env.example`           | **Missing**                                                                                              |
| CI                       | One workflow, `ci.yml`, with five jobs: verify, templates, modules, generated, security                  |
| Migrations               | Nine, version-controlled, with a `migration_lock.toml`                                                   |
| Migration safety checks  | **None**                                                                                                 |
| Health endpoints         | `@trustos/observability` provides `/health` and `/ready`; every NestJS app mounts them                   |
| Structured logging       | `@trustos/logging` — pino, with request and correlation ids                                              |
| Deployment documentation | `docs/railway-deployment.md`, written for a generated application rather than for the framework          |

## What CI already does

The existing `ci.yml` is stronger than most repositories at this stage. It runs:

- `npm ci`, format check, lint, typecheck, the full test suite
- Template validation across all 24 templates
- Module registry and SDK validation
- Generated-application verification — it generates an app from a template and builds it
- Lockfile drift detection
- `npm audit --omit=dev --audit-level=critical` as a hard gate
- `npm audit --audit-level=high` as a report
- A secret-bearing-file check on the working tree
- Prisma schema validation and migration drift

## Gaps

Ordered by what blocks a deployment.

| #   | Gap                                                  | Blocks                                                     |
| --- | ---------------------------------------------------- | ---------------------------------------------------------- |
| 1   | **No Dockerfiles**                                   | Any container deployment                                   |
| 2   | **No `.env.example`**                                | Anybody configuring an environment                         |
| 3   | **No Railway configuration for the real services**   | DEV and UAT deployment                                     |
| 4   | **No migration safety check**                        | A destructive migration reaching production                |
| 5   | **No smoke application or smoke tests**              | Proving a deployment works                                 |
| 6   | No release process or versioning documentation       | Promoting an artefact from DEV to UAT                      |
| 7   | No deployment documentation for the framework itself | Anybody deploying it                                       |
| 8   | No security review document                          | The pilot gate                                             |
| 9   | No backup or restore procedure                       | Recovery                                                   |
| 10  | Six high-severity dependency advisories              | Nothing — all have fixes; see the pilot's security results |

## Proposed Railway topology

Deliberately smaller than the specification's example, because three of its services do not exist.

```text
Railway project: trustos-dev
│
├── PostgreSQL                          managed, one per environment
│
├── trustos-api                 public   api-example — the reference API and smoke target
├── internal-app-gateway        private  the entrance internal applications call
├── governance-tool             public   the console runtime
├── enterprise-governance-admin private  data governance, policy, APIs, continuity
├── financial-product-admin     private  the product designer
├── sre-operations-console      private  service health and incidents
└── api-developer-portal        public   the developer-facing catalog
```

`trustos-uat` is the same shape with a separate database, separate secrets and separate endpoints.

**No PROD project is created by this work.** Its configuration is documented and nothing was
provisioned — a production project created "ready for later" is a production project somebody
deploys to.

Note that a Railway project named `TrustOS-Framework` **already exists** and is linked to this
repository, with one service in an environment named `production`. It predates this work and its
contents were not inspected, because the CLI session had expired. See
[`pilot-readiness.md`](pilot-readiness.md#the-two-unverified-items).

### What is deliberately absent

**No Redis.** The specification says to use it only where the current implementation requires it.
Nothing in the repository does: `@trustos/job-runtime` and `@trustos/scheduler` define ports and
in-memory implementations, and the Prisma stores use PostgreSQL. Adding Redis would be adding an
operational dependency to satisfy a diagram.

**No object storage.** Same reasoning. `@trustos/export` writes to a port; no implementation in
this repository requires a bucket.

**No worker services.** See above — they do not exist as applications.

**No message broker.** `@trustos/event-bus` publishes through a port with an in-process
implementation. Kafka is named in the constraints as something not to build.

### Which services are public

Only three: `trustos-api`, `governance-tool` and `api-developer-portal`.

`internal-app-gateway` is private _by name and by purpose_ — it is the entrance internal
applications call, over Railway's private network, and exposing it publicly would be exposing the
thing that exists to be the only door.

The three admin consoles are private because they administer the platform. A deployment that wants
them reachable puts them behind its own ingress with its own controls, which is a decision it
should make deliberately rather than inherit from a default.

## What this assessment does not change

No architectural change was made to reach these conclusions, and none is proposed. The framework
already separates libraries from applications correctly; what is missing is the packaging around
the applications, which is the rest of this phase.
