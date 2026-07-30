# Modules

A module is a reusable business capability. It is a real npm package with its own
tests, its own permissions and its own database tables, and it is installed into an
application by `trustos add-module`.

Seven ship with the framework:

| Module          | Capability                                                                                            | Tables | Routes |
| --------------- | ----------------------------------------------------------------------------------------------------- | ------ | ------ |
| `file-storage`  | Object storage behind a provider port, with checksums, versioning and per-organization key namespaces | 2      | 6      |
| `notification`  | Templated messages over email, Telegram and webhooks, with a retry queue and delivery history         | 3      | 10     |
| `document`      | Categorised documents with metadata, version history and soft delete                                  | 3      | 10     |
| `workflow`      | Approval workflows with task assignment, approval history, SLA tracking and escalation                | 4      | 10     |
| `reporting`     | Report definitions with filtering, pagination, CSV export and a PDF renderer port                     | 1      | 7      |
| `search`        | Global search across module adapters, with permission filtering and ranking                           | 0      | 2      |
| `feature-flags` | Boolean flags with percentage rollout, per-subject overrides, environment scoping and expiry          | 2      | 6      |

`trustos list-modules --verbose` prints the current surface of each: permissions,
routes, environment variables, feature flags, extension points and what each
deliberately does not do.

## What every module guarantees

These are not conventions. `defineModule` throws at import time if any of them is
violated, so a module that breaks one never reaches an application.

| Guarantee                          | Enforced by                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Organization-scoped                | `tenantScoped` must be `true`; all persistence goes through `ModuleRepository`, which wraps `@trustos/tenancy`           |
| Every route carries a permission   | A route must name a permission the module declares, and there is no "public" option                                      |
| Permissions cannot collide         | Every key must start with the module id; the registry refuses two modules claiming one key                               |
| Audit actions cannot collide       | Same namespacing rule, same refusal                                                                                      |
| Installs with no configuration     | `configSchema` must accept `{}`, so `add-module` never leaves an application that cannot start                           |
| Unknown configuration fails loudly | Every schema is `.strict()`: a typo in a deployment's config is an error, not a silently ignored key                     |
| Contributes to readiness           | Each module supplies a `HealthIndicator`, registered with the application's `HealthRegistry` and visible in `GET /ready` |
| Cannot grant itself access         | Nothing in the module system writes a role; permissions are printed and the application's seed decides                   |

The last one is worth restating: a module that could grant its own permissions would
be a privilege-escalation path inside a package.

## Installing

```bash
# From the framework checkout, pointing at a generated application:
trustos add-module notification --path ../my-app --framework-path .

# Dependencies come with it. `document` needs `file-storage`:
trustos add-module document --path ../my-app --framework-path .
#   → installs file-storage, then document

# See what would change, write nothing:
trustos add-module workflow --path ../my-app --framework-path . --dry-run --verbose
```

### What the installer writes

| File                                      | Ownership                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `prisma/schema/NN-<module>.prisma`        | The module's. Refreshed on reinstall.                                  |
| `apps/api/src/modules/trustos-modules.ts` | The installer's. Regenerated from the full installed set.              |
| `apps/api/src/modules/module-config.ts`   | Yours. Created once and never rewritten.                               |
| `docs/modules.md` (in the application)    | The installer's. Regenerated.                                          |
| `package.json`                            | Merged: module packages added to `dependencies`, nothing else touched. |
| `trustos.json`                            | Merged: the `modules` array. Unknown keys preserved.                   |
| `.env.example`                            | Merged: one anchored block per module, names only, never values.       |

Everything the installer owns carries a marker comment. A file that exists, is not
one of the merge targets, and has no marker is treated as code somebody wrote — the
run stops and names it rather than overwriting it.

`app.module.ts` is never touched. It spreads `TRUSTOS_MODULE_IMPORTS`, so the guard
order that makes up the security model stays under human control.

### After installing

```bash
npm install
npm run db:migrate     # generates the SQL for the new fragments
npm test
```

Then seed the permissions. `TRUSTOS_MODULE_PERMISSIONS` in
`apps/api/src/modules/trustos-modules.ts` is the full list, and the suggested roles
are in the generated `docs/modules.md`.

### Reinstalling is safe

`add-module` is idempotent. A module already present is reported and skipped; the
managed files are regenerated from the whole installed set, so nothing accumulates.
A failed run is rolled back: files it created are removed and files it overwrote are
restored.

## How a module reaches the application

```
                    ┌─────────────────────────────┐
  trustos.json ─────│  installed module list      │
                    └─────────────┬───────────────┘
                                  │  add-module regenerates
                                  ▼
       apps/api/src/modules/trustos-modules.ts   (managed)
                                  │  exports TRUSTOS_MODULE_IMPORTS
                                  ▼
              apps/api/src/app.module.ts         (yours)
                     imports: [ ..., ...TRUSTOS_MODULE_IMPORTS ]
```

Each entry is `SomeModule.forRoot(binding)`, where the binding names the
application's own tokens — `APP_LOGGER`, `AUDIT_SERVICE`, `PrismaService`. A module
never assumes a host has adopted a particular token name, which is what makes the
same package installable into an application this repository has never seen.

On start-up each module's `initialize()` runs and its health indicator is registered
with the application's readiness probe. On shutdown, `shutdown()` runs.

## Extension points

Every module is built around ports, and each one is declared rather than merely
documented — `trustos list-modules --verbose` lists them, because the moment someone
needs to know is the moment before they fork a module instead of extending it.

| Module          | Port                  | Replace it to…                                    |
| --------------- | --------------------- | ------------------------------------------------- |
| `file-storage`  | `StorageProvider`     | move bytes from local disk to object storage      |
| `file-storage`  | `StoredObjectStore`   | keep object rows somewhere other than Postgres    |
| `notification`  | `NotificationChannel` | send real email, real Telegram, real webhooks     |
| `notification`  | `RetryQueue`          | make pending deliveries durable across restarts   |
| `notification`  | `NotificationStore`   | keep templates and messages elsewhere             |
| `document`      | `DocumentStore`       | keep document rows elsewhere                      |
| `document`      | `StorageProvider`     | change where document content lives               |
| `workflow`      | `EscalationHook`      | page someone when an approval breaches its SLA    |
| `workflow`      | `WorkflowStore`       | keep instances and history elsewhere              |
| `reporting`     | `ReportDataSource`    | supply the rows for a report the application owns |
| `reporting`     | `PdfRenderer`         | implement PDF export                              |
| `reporting`     | `ReportScheduleStore` | keep schedules elsewhere                          |
| `search`        | `SearchAdapter`       | make one more thing searchable                    |
| `search`        | `Ranker`              | change what "most relevant" means                 |
| `feature-flags` | `FeatureFlagStore`    | keep flags elsewhere                              |

Two of these are the seams the framework's constraints are built around:

- **`NotificationChannel`** is where a real provider goes. The queue, the retry
  policy, the delivery state machine, the audit trail and the per-tenant
  configuration are all real and tested; only the last hop is a mock. Swapping in
  SES or the Telegram Bot API is one class, precisely because none of the
  surrounding behaviour was built inside a provider adapter.

- **`ReportDataSource`** is where an application's data goes. The module owns
  filtering, pagination, CSV export and audit; it never learns what a payout is.

## What is deliberately absent

| Not here                                   | Extension point instead                                   |
| ------------------------------------------ | --------------------------------------------------------- |
| Real email providers (SMTP, SES, SendGrid) | `NotificationChannel`                                     |
| Real Telegram Bot API calls                | `NotificationChannel`                                     |
| Redis, Kafka, or any durable queue         | `RetryQueue`                                              |
| Cloud object storage (S3, GCS, Azure)      | `StorageProvider`                                         |
| Elasticsearch, OpenSearch, any index       | `SearchAdapter`                                           |
| A PDF rendering stack                      | `PdfRenderer`                                             |
| A scheduler runtime                        | `ReportScheduleStore` plus `dueSchedules`                 |
| Payment logic                              | Not a framework concern; see the payment-gateway template |
| AI functionality                           | Out of scope for this phase                               |

Each of these is a product decision with operational consequences, and a framework
that makes it for every vertical is a framework that has to be worked around.

## Running a linked application

A generated application installed with `--framework-path` links the `@trustos/*`
packages with `file:` specifiers. Node resolves a symlinked package's own
dependencies from the _framework's_ `node_modules`, so a linked application shares
the framework's copy of `@nestjs/core`. Nest's `Reflector` is then a different class
in the framework's packages than in the application, and dependency injection
cannot resolve.

The consequence, stated plainly: a linked application **builds, typechecks and
tests, but does not boot**. Running one requires the `@trustos/*` packages to be
installed as ordinary packages — published to a registry, or installed from
tarballs. `@trustos/database` additionally needs to ship its generated Prisma
client for that to typecheck, which it does not yet.

The module wiring itself is verified inside this repository, where there is one copy
of Nest: `packages/modules/nest-wiring.spec.ts` boots a real Nest application with
all seven modules and asserts that injection resolves, that every route the catalog
advertises is mapped, that each `initialize` ran, and that the health indicators
reach the readiness probe.

## Reading further

- `docs/module-development.md` — writing a module, and the rules it must follow.
- `docs/module-versioning.md` — versions, compatibility and what counts as breaking.
- `docs/cli.md` — `add-module` and `list-modules` in full.
- Each module's `README.md` and `AGENTS.md`, in `packages/modules/<id>/`.
