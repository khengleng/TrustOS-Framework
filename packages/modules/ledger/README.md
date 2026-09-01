# @trustsystem/module-ledger

Double-entry bookkeeping: journals, accounts, reversal, trial balance and reporting. Posted journals are immutable and every journal must balance.

## What this package is

A thin module wrapper. The implementation is in `@trustsystem/accounts`, `@trustsystem/financial-core`, `@trustsystem/financial-policy`, `@trustsystem/financial-reporting`, `@trustsystem/ledger`; this package contributes the declarations the platform needs — permissions,
audit events and a health indicator — and the start/stop lifecycle.

## Installing

```bash
trustos add-module ledger
```

That adds the dependency and the documentation. Wiring is a Nest module import in the
application's composition root:

```ts
import { LedgerModule } from '@trustsystem/module-ledger/nest';

@Module({ imports: [LedgerModule.forRoot(binding)] })
export class AppModule {}
```

The financial tables are part of the framework schema, so there is no migration to run.

## What it does not do

See `outOfScope` in the module catalog (`trustos list-modules --verbose`). The short version:
this is a financial foundation, not a bank and not a payment gateway. It ships no provider
integration and no scheme implementation.
