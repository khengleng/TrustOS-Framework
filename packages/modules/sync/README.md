# @trustsystem/module-sync

Pull, push and bidirectional synchronization with incremental watermarks and conflict policies.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/sync`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module sync
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { SyncModule } from '@trustsystem/module-sync/nest';

@Module({ imports: [SyncModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose sync`). The
short version: this phase ships the seam, not the integration.
