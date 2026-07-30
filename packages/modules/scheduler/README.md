# @trustos/module-scheduler

Cron, interval and one-time schedules with IANA timezone support and explicit daylight-saving handling.

## What this package is

A thin module wrapper. The implementation is in `@trustos/scheduler`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module scheduler
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { SchedulerModule } from '@trustos/module-scheduler/nest';

@Module({ imports: [SchedulerModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose scheduler`). The
short version: this phase ships the seam, not the integration.
