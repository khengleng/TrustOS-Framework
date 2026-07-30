# AGENTS.md — Workflow

Instructions for an AI coding agent working on `@trustos/module-workflow`.

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

1. **Separation of duties.** A submitter cannot approve — or reject — their own
   request unless the step explicitly says so. An approval chain whose submitter can
   approve is not a control; it is a log entry that looks like one. Every regulated
   product installing this module inherits whatever these tests allow.
2. **A blocked self-approval is audited before it is refused.** An attempted
   self-approval is exactly what a reviewer wants to see; a silent 403 leaves no
   trace.
3. **Required approvals count distinct actors**, taken from the append-only history.
   Counting decisions would let one person approve twice and satisfy a two-approver
   step.
4. **Definitions are immutable once registered.** A running instance holds a step
   index into the definition it started with.
5. **Terminal instance states cannot be reopened.** A rejection is terminal; "send it
   back for amendment" is a new submission.
6. **Assignment is by permission, not by user id.** A workflow that names individuals
   stops working the first time someone leaves.
7. **A task escalates once.** `escalatedAt` is set before the hook runs, because a
   notification storm is a worse failure than a missed escalation — and the missed
   one is in the audit trail.

## Where things are

| File                      | What it holds                                                         |
| ------------------------- | --------------------------------------------------------------------- |
| `src/config.ts`           | Zod configuration schema. Must stay `.strict()` and must accept `{}`. |
| `src/store.ts`            | Persistence ports and the Prisma implementation.                      |
| `src/workflow.service.ts` | Orchestration, audit, tenant checks.                                  |
| `src/workflow.module.ts`  | `defineModule`, `create()`, lifecycle, health.                        |
| `src/nest/`               | Controller, tokens and the Nest module.                               |
| `install/`                | What `trustos add-module` copies into an application.                 |

Declarations — permissions, routes, audit events, migrations, flags, environment
variables — are **not** in this package. They live in
`packages/module-registry/src/catalog.ts`. Change them there.

## Before you finish

```bash
npx vitest run packages/modules/workflow
npx vitest run packages/modules/all-modules.spec.ts packages/modules/nest-wiring.spec.ts
npm run build:packages && npm run lint
```
