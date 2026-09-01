# AGENTS.md — Search

Instructions for an AI coding agent working on `@trustsystem/module-search`.

Read `docs/ai-agent-instructions.md` at the framework root first, then
`docs/module-development.md`. This file adds what is specific to this module.

## Rules

1. **Never duplicate framework functionality.** Tenant scoping is
   `@trustsystem/tenancy`, reached through `ModuleRepository`. Audit is the audit port on
   `ModuleContext`. Validation is Zod via `@trustsystem/validation`. Errors are
   `ApiError`. Health is `HealthIndicator`. Writing a second implementation of any of
   these is the failure mode this file exists to prevent.
2. **Reuse the SDK.** `ModuleRepository`, `createModuleContext`,
   `moduleHealthIndicator`, and for tests `createTestModuleContext`,
   `RecordingAuditPort`, `createTestClock`, `FakeModelDelegate`.
3. **Add tests.** Every change needs one. Tenant isolation, RBAC where the module
   makes its own authorization decisions, and configuration validation are not
   optional — CI checks that this module has all three.
4. **Register audit events.** A mutation with no audit record is not shippable. Add
   the action to the catalog entry first; `defineModule` will refuse an action outside
   the module namespace.
5. **Document configuration.** Every field in `config.ts` gets a comment saying what
   it does and why its default is what it is. `docs/modules.md` in a generated
   application is derived from the catalog, so keep the catalog descriptions accurate.
6. **Preserve compatibility.** Permission keys, audit actions, flag keys, route paths
   and environment variable names are permanent. Add them; never rename one. See
   `docs/module-versioning.md`.
7. **Avoid breaking changes.** If a change would break a caller, add the new thing
   alongside the old, support both, and record the removal for a later version.

## Invariants specific to this module

Do not weaken any of these without a security review. Each has a test named after it.

1. **A source the caller cannot read is never queried.** Filtering after the fact is
   one refactor away from leaking; filtering the adapter list is not.
2. **Every hit's `organizationId` is verified.** A hit from another organization is
   dropped, audited and counted — not trusted because the adapter should have
   scoped it.
3. **A source the caller cannot read and one that does not exist give the same
   answer.** Otherwise naming a source is a way to discover which exist.
4. **Rank, then paginate.** The other order returns the most relevant results on an
   arbitrary page.
5. **Ranking is stable.** An unstable ranking returns the same row on two pages and
   skips another.
6. **The search term is audited; the results are not.** Searching for a person's name
   is what an insider-threat review asks about. A trail of what someone found is a
   second copy of the data with different access controls.
7. **No index.** Adapters query what the owning module already stores. An index is a
   second copy of customer data to keep tenant-correct.

## Where things are

| File                    | What it holds                                                         |
| ----------------------- | --------------------------------------------------------------------- |
| `src/config.ts`         | Zod configuration schema. Must stay `.strict()` and must accept `{}`. |
| `src/store.ts`          | Persistence ports and the Prisma implementation.                      |
| `src/search.service.ts` | Orchestration, audit, tenant checks.                                  |
| `src/search.module.ts`  | `defineModule`, `create()`, lifecycle, health.                        |
| `src/nest/`             | Controller, tokens and the Nest module.                               |
| `install/`              | What `trustos add-module` copies into an application.                 |

Declarations — permissions, routes, audit events, migrations, flags, environment
variables — are **not** in this package. They live in
`packages/module-registry/src/catalog.ts`. Change them there.

## Before you finish

```bash
npx vitest run packages/modules/search
npx vitest run packages/modules/all-modules.spec.ts packages/modules/nest-wiring.spec.ts
npm run build:packages && npm run lint
```
