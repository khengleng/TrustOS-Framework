# @trustos/module-jobs

A durable job queue in the database: leased execution, retry with backoff, priority, progress and history.

## What this package is

A thin module wrapper. The implementation is in `@trustos/job-runtime`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module jobs
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { JobsModule } from '@trustos/module-jobs/nest';

@Module({ imports: [JobsModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose jobs`). The
short version: this phase ships the seam, not the integration.
