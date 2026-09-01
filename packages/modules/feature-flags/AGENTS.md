# AGENTS.md — Feature Flags

Instructions for an AI coding agent working on `@trustsystem/module-feature-flags`.

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

1. **Every evaluation rule can only turn a flag off.** That is the safety property: a
   flag that is unknown, expired, out of environment or impossible to bucket
   evaluates to off, and the feature stays behind the gate. The one exception is an
   explicit per-subject override, which is a row somebody created.
2. **The evaluation order is fixed**, and expiry and environment are checked _before_
   overrides — otherwise a per-subject allow-list in staging leaks a feature into
   production.
3. **Bucketing is stable, per-flag independent and monotonic.** Stable, or the feature
   flickers mid-session. Per-flag independent, or the same unlucky cohort receives
   every experiment. Monotonic, or widening a rollout takes the feature away from
   someone.
4. **A new flag is created off.** A flag created enabled has shipped the feature
   before anyone reviewed the rollout.
5. **An unknown flag evaluates to off rather than raising.** A typo must not take down
   the code path it gated, and must not enable it either.
6. **The rollout salt is a constant default, not a random one.** A salt that changed
   per process would reshuffle every rollout on every deploy.

## Where things are

| File                           | What it holds                                                         |
| ------------------------------ | --------------------------------------------------------------------- |
| `src/config.ts`                | Zod configuration schema. Must stay `.strict()` and must accept `{}`. |
| `src/store.ts`                 | Persistence ports and the Prisma implementation.                      |
| `src/feature-flags.service.ts` | Orchestration, audit, tenant checks.                                  |
| `src/feature-flags.module.ts`  | `defineModule`, `create()`, lifecycle, health.                        |
| `src/nest/`                    | Controller, tokens and the Nest module.                               |
| `install/`                     | What `trustos add-module` copies into an application.                 |

Declarations — permissions, routes, audit events, migrations, flags, environment
variables — are **not** in this package. They live in
`packages/module-registry/src/catalog.ts`. Change them there.

## Before you finish

```bash
npx vitest run packages/modules/feature-flags
npx vitest run packages/modules/all-modules.spec.ts packages/modules/nest-wiring.spec.ts
npm run build:packages && npm run lint
```
