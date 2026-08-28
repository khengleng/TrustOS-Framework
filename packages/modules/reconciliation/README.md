# @trustos/module-reconciliation

Internal and external reconciliation with tolerance rules, an exception queue and resolution history.

## What this package is

A thin module wrapper. The implementation is in `@trustos/financial-core`, `@trustos/reconciliation`; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module reconciliation
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { ReconciliationModule } from '@trustos/module-reconciliation/nest';

@Module({ imports: [ReconciliationModule.forRoot(binding)] })
export class AppModule {}
```

The financial tables are part of the framework schema, so there is no migration to run.

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose`). The short version:
this is a financial foundation, not a bank and not a payment gateway. It ships no provider
integration and no scheme implementation.
