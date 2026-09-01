# @trustsystem/module-webhook

Outbound webhooks with HMAC signatures, overlapping secret rotation, replay protection and delivery history.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/webhooks`, `@trustsystem/webhook-runtime`; this package contributes the declarations the platform needs — permissions,
routes, audit events, migrations and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module webhook
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { WebhookModule } from '@trustsystem/module-webhook/nest';

@Module({ imports: [WebhookModule.forRoot(binding)] })
export class AppModule {}
```

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose webhook`). The
short version: this phase ships the seam, not the integration.
