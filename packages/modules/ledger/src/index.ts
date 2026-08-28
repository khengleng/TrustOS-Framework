/**
 * @trustos/module-ledger
 *
 * Double-entry bookkeeping: journals, accounts, reversal, trial balance and reporting. Posted journals are immutable and every journal must balance.
 *
 * The implementation lives in `@trustos/accounts`, `@trustos/financial-core`, `@trustos/financial-policy`, `@trustos/financial-reporting`, `@trustos/ledger`; this
 * package is the module contract around it.
 */
export * from './ledger.module';
