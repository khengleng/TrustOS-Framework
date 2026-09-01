# @trustsystem/module-events

Typed, versioned domain events with a schema registry, ordering per aggregate, retry, dead letters and replay.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/event-bus`, `@trustsystem/event-registry`, `@trustsystem/event-sdk`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module events
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { EventsModule } from '@trustsystem/module-events/nest';

@Module({ imports: [EventsModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose events`). The
short version: this phase ships the seam, not the integration.
