# @trustsystem/module-registry

Two things, both about discovery.

## The catalog

Validated data describing every approved module: its metadata, permissions, routes,
audit events, migrations, feature flags, environment variables, extension points and
dependencies. It is the single declaration point — module packages read their own
entry through `moduleDeclarations(id)` rather than restating it.

```ts
import { moduleDeclarations } from '@trustsystem/module-registry';

export const searchModule = defineModule({
  ...moduleDeclarations('search'),
  configSchema,
  tenantScoped: true,
  create,
});
```

Two consequences, and they are why the declarations live here:

1. **The CLI can read it without executing a module.** `trustos add-module` needs a
   module's permissions and migrations to install it. Taking them from data means the
   installer never imports module code, so nothing a module could do at import time
   runs during an install.

2. **Collisions between modules are impossible to miss.** Two modules claiming
   `GET /reports`, or both defining `document.read`, would otherwise be reviewed in
   two files by two people. Here they are twelve lines apart and the catalog refuses
   to load.

The catalog validates on import, per entry and across entries: duplicate ids,
permission keys, routes, schema fragments and environment variables are all refused,
dependencies must resolve, and the graph must be acyclic.

## The registry

The in-memory list an application builds at start-up. It decides start order, stop
order, health indicators and the permission catalog to seed.

```ts
const registry = new ModuleRegistry();
registry.register(notificationModule, notificationModule.create(context));

await registry.initializeAll(); // dependency order; rolls back a failed start-up
const indicators = registry.healthIndicators();
await registry.shutdownAll(); // reverse order; collects failures
```

Registration is strict: two modules claiming one permission key or one route are
refused rather than merged. A merged permission is a single grant that opens two
doors, and a merged route is whichever controller Nest bound last.

Start-up is transactional. If module three of five fails, the two already started are
shut down before the error propagates — a half-started application serves traffic
against modules whose invariants were never established.

## Resolution

```ts
resolveInstallOrder(MODULE_CATALOG, ['document'], { frameworkVersion: '0.1.0' });
// → order: [file-storage, document], addedForDependencies: ['file-storage']
```

Dependency-first, idempotent against what is already installed, and refusing a module
that needs a newer framework than the application records. Caret ranges follow npm
including the pre-1.0 rule, so `^0.1.0` does not accept `0.2.0`.

## See also

- `docs/modules.md`
- `docs/module-versioning.md`
