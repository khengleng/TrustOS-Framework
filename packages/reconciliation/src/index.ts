/**
 * @trustos/reconciliation
 *
 * Internal and external reconciliation: matching, tolerance rules, exception queue and resolution.
 *
 * The output is a **queue, not a number**. "£3.42 out" is not actionable; "these four are on the
 * statement and not in the ledger" is. Matching is by reference first, because amount-only matching
 * pairs two unrelated payments and reports a clean reconciliation.
 */
export * from './reconciliation';
export * from './testing';
