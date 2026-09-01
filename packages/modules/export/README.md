# @trustsystem/module-export

Streaming export to CSV, JSON and NDJSON with keyset pagination and formula-injection escaping.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/export`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module export
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { ExportModule } from '@trustsystem/module-export/nest';

@Module({ imports: [ExportModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose export`). The
short version: this phase ships the seam, not the integration.
