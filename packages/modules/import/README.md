# @trustsystem/module-import

Bulk import with CSV and JSON parsing, per-row validation, preview, dry run, apply and rollback.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/import`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module import
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { ImportModule } from '@trustsystem/module-import/nest';

@Module({ imports: [ImportModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose import`). The
short version: this phase ships the seam, not the integration.
