/**
 * @trustos/ledger
 *
 * Double-entry bookkeeping: journals, postings, reversal, adjustment and the trial balance.
 *
 * Three rules, all enforced rather than documented: a journal must balance before it posts, a
 * posted journal is immutable, and a correction is a new journal. Read the header of `journal.ts`
 * for why each one is absolute.
 */
export * from './journal';
export * from './ledger';
export * from './testing';
