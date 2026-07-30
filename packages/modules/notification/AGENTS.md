# AGENTS.md — Notification

Instructions for an AI coding agent working on `@trustos/module-notification`.

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

1. **`template-engine.ts` is not a template language, and must not become one.**
   Message templates are authored by customers, which makes them untrusted input.
   Compiling untrusted input with Handlebars, Nunjucks or EJS is server-side
   template injection. Substitution is literal, single-pass, and total.
2. **Single-pass substitution.** A value containing `{{other}}` must not be expanded
   on a second pass. There is a test named for it.
3. **A message row is written before delivery is attempted.** The reverse order loses
   exactly the messages whose delivery crashed the process.
4. **Terminal delivery states have no outgoing transitions.** Every count of "how
   many did we send" depends on it. `FAILED` means "will be retried"; `DEAD` means
   "we stopped". Do not merge them.
5. **Rendered bodies never reach the audit trail.** The target and template key do.
6. **The channels are mocks, and their failures are deterministic.** A mock that
   fails randomly makes the suite flaky and teaches people to re-run it.

## Where things are

| File                          | What it holds                                                         |
| ----------------------------- | --------------------------------------------------------------------- |
| `src/config.ts`               | Zod configuration schema. Must stay `.strict()` and must accept `{}`. |
| `src/store.ts`                | Persistence ports and the Prisma implementation.                      |
| `src/notification.service.ts` | Orchestration, audit, tenant checks.                                  |
| `src/notification.module.ts`  | `defineModule`, `create()`, lifecycle, health.                        |
| `src/nest/`                   | Controller, tokens and the Nest module.                               |
| `install/`                    | What `trustos add-module` copies into an application.                 |

Declarations — permissions, routes, audit events, migrations, flags, environment
variables — are **not** in this package. They live in
`packages/module-registry/src/catalog.ts`. Change them there.

## Before you finish

```bash
npx vitest run packages/modules/notification
npx vitest run packages/modules/all-modules.spec.ts packages/modules/nest-wiring.spec.ts
npm run build:packages && npm run lint
```
