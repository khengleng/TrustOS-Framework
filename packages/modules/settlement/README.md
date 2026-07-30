# @trustos/module-settlement

Settlement batches, instructions and windows, with partial confirmation and returns. Asynchronous by construction.

## What this package is

A thin module wrapper. The implementation is in `@trustos/financial-core`, `@trustos/settlement`; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module settlement
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { SettlementModule } from '@trustos/module-settlement/nest';

@Module({ imports: [SettlementModule.forRoot(binding)] })
export class AppModule {}
```

The financial tables are part of the framework schema, so there is no migration to run.

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose`). The short version:
this is a financial foundation, not a bank and not a payment gateway. It ships no provider
integration and no scheme implementation.
