# TrustOS SaaS starter

Copy this folder to start a new TrustOS product on the framework.

```bash
cp -r templates/saas-starter apps/my-product
# edit apps/my-product/package.json: name -> @trustos/my-product
npm install
npm run build:packages
npm run dev -w @trustos/my-product
```

## What you get, already wired

| Concern                                         | Where                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Validated configuration, fail-fast at boot      | `src/main.ts` — `loadConfig()`                                    |
| Structured logging with request correlation     | `src/main.ts` — `requestContextMiddleware`                        |
| Standard error responses, no production leakage | `src/main.ts` — `AllExceptionsFilter`                             |
| Authentication                                  | `src/app.module.ts` — `JwtAuthGuard`                              |
| Tenant isolation                                | `src/app.module.ts` — `TenantGuard`, plus `tenantScopeMiddleware` |
| Deny-by-default authorization                   | `src/app.module.ts` — `PermissionsGuard`                          |
| Audit trail                                     | `src/app.module.ts` — `AuditService` + `PrismaAuditSink`          |
| Health and readiness probes                     | `src/app.module.ts` — `ObservabilityModule`                       |
| Railway deployment                              | `railway.json`                                                    |

## The example module

`src/modules/widgets` is a complete, working feature written the way a product
feature should be written. Read all five files before replacing them:

| File                     | Shows                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `widgets.permissions.ts` | Namespacing your own permission keys                                           |
| `widgets.controller.ts`  | A permission on every route, `@OrganizationId()` in the handler                |
| `widgets.service.ts`     | `organizationId` as a parameter; audit on every mutation, never on a read      |
| `widgets.repository.ts`  | Tenant-filtered storage, and how to swap it for a `scopedDelegate` over Prisma |
| `widgets.spec.ts`        | The four tenant-isolation assertions every product model owes                  |

The repository is in-memory so the template runs before you have added a table.
The comment at the top of `widgets.repository.ts` is the three-step change to
Prisma.

## What to change

- Add your modules to `imports` in `src/app.module.ts`.
- Change the Swagger title in `src/main.ts`.
- Set `SERVICE_NAME` in the environment.

## What not to change

The three global guards and their order. They are the framework's security
model, not this template's opinion — see
[`docs/architecture.md`](../../docs/architecture.md) §5 and
[`docs/ai-agent-instructions.md`](../../docs/ai-agent-instructions.md).
