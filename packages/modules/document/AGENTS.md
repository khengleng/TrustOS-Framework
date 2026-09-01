# AGENTS.md — Document

Instructions for an AI coding agent working on `@trustsystem/module-document`.

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

1. **Content goes through `file-storage`'s `StorageProvider` port.** Do not add a
   second implementation of object storage or of path containment; that is the whole
   reason for the module dependency.
2. **The content-type list is an allow-list.** A format nobody thought about is
   refused, not accepted. An HTML document served back from a customer-facing
   endpoint is stored cross-site scripting.
3. **Version history is append-only.** Rows are written, never updated.
4. **Soft delete leaves the bytes in place.** A document filed against a case may be
   subject to a retention period the module knows nothing about.
5. **A download is audited.** "Who opened this contract" is the question asked
   afterwards.
6. **Neither content nor the free-text description reaches the audit trail.**

## Where things are

| File                      | What it holds                                                         |
| ------------------------- | --------------------------------------------------------------------- |
| `src/config.ts`           | Zod configuration schema. Must stay `.strict()` and must accept `{}`. |
| `src/store.ts`            | Persistence ports and the Prisma implementation.                      |
| `src/document.service.ts` | Orchestration, audit, tenant checks.                                  |
| `src/document.module.ts`  | `defineModule`, `create()`, lifecycle, health.                        |
| `src/nest/`               | Controller, tokens and the Nest module.                               |
| `install/`                | What `trustos add-module` copies into an application.                 |

Declarations — permissions, routes, audit events, migrations, flags, environment
variables — are **not** in this package. They live in
`packages/module-registry/src/catalog.ts`. Change them there.

## Before you finish

```bash
npx vitest run packages/modules/document
npx vitest run packages/modules/all-modules.spec.ts packages/modules/nest-wiring.spec.ts
npm run build:packages && npm run lint
```
