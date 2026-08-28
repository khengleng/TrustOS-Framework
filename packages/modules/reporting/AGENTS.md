# AGENTS.md — Reporting

Instructions for an AI coding agent working on `@trustos/module-reporting`.

Read `docs/ai-agent-instructions.md` at the framework root first, then
`docs/module-development.md`. This file adds what is specific to this module.

## Rules

1. **Never duplicate framework functionality.** Tenant scoping is
   `@trustos/tenancy`, reached through `ModuleRepository`. Audit is the audit port on
   `ModuleContext`. Validation is Zod via `@trustos/validation`. Errors are
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

1. **`escapeCsvCell` is a security control, not formatting.** `=cmd|' /c calc'!A1` in
   a CSV opened in Excel is code execution on the machine of whoever opened it, and
   the cell contents are customer data. Do not remove the apostrophe prefix.
2. **Column order comes from the definition, not from the first row.** A row missing
   an optional field would otherwise shift every later column.
3. **Report definitions are code, not rows.** A report that can be authored at
   runtime is a query builder, and a query builder exposed to customers is an
   unbounded read of whatever the database will join.
4. **An oversized export is refused, not truncated.** A partial export that looks
   complete is how a reconciliation ends up short by exactly the rows nobody knew
   were missing.
5. **A report the caller may not read is `not_found`, not `forbidden`.** A report id
   names the data it exposes.
6. **Rows carrying a foreign `organizationId` fail the report.** A report is the
   shape in which a cross-tenant leak goes unnoticed: a list nobody reads
   individually.
7. **Runs and exports are audited with their filters, never their rows.**

## Where things are

| File                       | What it holds                                                         |
| -------------------------- | --------------------------------------------------------------------- |
| `src/config.ts`            | Zod configuration schema. Must stay `.strict()` and must accept `{}`. |
| `src/store.ts`             | Persistence ports and the Prisma implementation.                      |
| `src/reporting.service.ts` | Orchestration, audit, tenant checks.                                  |
| `src/reporting.module.ts`  | `defineModule`, `create()`, lifecycle, health.                        |
| `src/nest/`                | Controller, tokens and the Nest module.                               |
| `install/`                 | What `trustos add-module` copies into an application.                 |

Declarations — permissions, routes, audit events, migrations, flags, environment
variables — are **not** in this package. They live in
`packages/module-registry/src/catalog.ts`. Change them there.

## Before you finish

```bash
npx vitest run packages/modules/reporting
npx vitest run packages/modules/all-modules.spec.ts packages/modules/nest-wiring.spec.ts
npm run build:packages && npm run lint
```
