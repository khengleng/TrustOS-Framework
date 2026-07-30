# @trustos/module-sdk

The contract every TrustOS module implements.

```ts
export const notificationModule = defineModule<NotificationConfig>({
  ...moduleDeclarations('notification'), // from @trustos/module-registry
  configSchema: notificationConfigSchema,
  tenantScoped: true,
  create: (context) => createNotification(context),
});
```

## What `defineModule` enforces

At import time, so an invalid module never reaches an application:

- `tenantScoped` must be `true`
- every permission key, audit action and flag key must start with the module id
- every environment variable must start with the module's upper-snake prefix
- every route must name a permission the module declares, and there is no "public"
  option
- no duplicate permissions, routes, migrations, flags or environment variables
- no self-dependency and no duplicate dependency
- `configSchema` must accept `{}`, so the module installs with safe defaults

Every problem is reported at once rather than one per run, because fixing
declarations one failure at a time is how a module ends up with the minimum number of
declarations someone had patience for.

## What a module receives

`ModuleContext` is the whole interface to the host:

| Field                           | Notes                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| `config`                        | Validated at construction, not at first use                                            |
| `logger`                        | `LoggerPort` from `@trustos/logging`                                                   |
| `audit`                         | A narrow port: `record` only. A module writes history and has no business reading it   |
| `environment`                   | `development` \| `test` \| `production`                                                |
| `clock()`                       | Injectable. Modules must not call `new Date()`                                         |
| `prisma`                        | The host's client, or null. A module that needs one refuses to initialize              |
| `tenantSettings`                | Per-organization overrides                                                             |
| `resolveConfig(organizationId)` | Base config merged with that organization's overrides, re-validated by the same schema |

A module never reads `process.env`, never builds a Prisma client and never imports
application code — which is what makes the same module usable from an API, a worker
and a test without change.

## Persistence

`ModuleRepository` wraps `@trustos/tenancy`, so `organizationId` is applied
structurally rather than remembered per call site. It has no method that can read
outside the active organization.

Every method is `async`, including the one-liners: resolving the delegate can throw
before the delegate is called, and without `async` those failures would be thrown
synchronously from a call site that looks asynchronous.

## Testing

```ts
const { context, audit } = createTestModuleContext(myModule, {
  config: { maxAttempts: 2 },
  prisma: { myThing: new FakeModelDelegate([...]) },
});
```

`createTestModuleContext` fixes the clock; `createTestClock` gives one that moves for
SLA and retry assertions. `RecordingAuditPort` collects records and offers
`serialized()` for asserting that a secret never reached the trail.

## NestJS

`@trustos/module-sdk/nest` provides `moduleProviders`, which wires the context, the
instance and the lifecycle. The host names its own tokens:

```ts
const binding: ModuleHostBinding = {
  inject: [APP_LOGGER, AUDIT_SERVICE, PrismaService, APP_CONFIG_TOKEN],
  useFactory: (logger, audit, prisma, config) => ({
    logger,
    audit,
    prisma,
    environment: config.env,
  }),
};
```

Explicit rather than resolved from ambient global tokens, so a module never depends
on a host having adopted a particular token name.

On start-up the lifecycle provider runs `initialize()` and registers the module's
health indicator with the application's `HealthRegistry`; on shutdown it runs
`shutdown()`. Nest initializes in its own import order — a host needing the
dependency-ordered, transactional start-up uses `ModuleRegistry.initializeAll`.

## See also

- `docs/modules.md`
- `docs/module-development.md`
