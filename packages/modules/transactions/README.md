# @trustsystem/module-transactions

The transaction lifecycle with idempotency, fees, limits, risk hooks and payment requests.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/fees`, `@trustsystem/financial-core`, `@trustsystem/financial-risk`, `@trustsystem/fx`, `@trustsystem/limits`, `@trustsystem/payments`, `@trustsystem/transactions`; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module transactions
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { TransactionsModule } from '@trustsystem/module-transactions/nest';

@Module({ imports: [TransactionsModule.forRoot(binding)] })
export class AppModule {}
```

The financial tables are part of the framework schema, so there is no migration to run.

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose`). The short version:
this is a financial foundation, not a bank and not a payment gateway. It ships no provider
integration and no scheme implementation.
