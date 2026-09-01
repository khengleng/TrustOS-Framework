# @trustsystem/module-adapter

The five-method provider contract with a registry, circuit-breaker-guarded calls and lifecycle management.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/adapter-framework`, `@trustsystem/provider-sdk`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module adapter
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { AdapterModule } from '@trustsystem/module-adapter/nest';

@Module({ imports: [AdapterModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose adapter`). The
short version: this phase ships the seam, not the integration.
