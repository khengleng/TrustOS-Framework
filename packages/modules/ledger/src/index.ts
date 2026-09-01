/**
 * @trustsystem/module-ledger
 *
 * Double-entry bookkeeping: journals, accounts, reversal, trial balance and reporting. Posted journals are immutable and every journal must balance.
 *
 * The implementation lives in `@trustsystem/accounts`, `@trustsystem/financial-core`, `@trustsystem/financial-policy`, `@trustsystem/financial-reporting`, `@trustsystem/ledger`; this
 * package is the module contract around it.
 */
export * from './ledger.module';
