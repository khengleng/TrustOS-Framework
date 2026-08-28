/**
 * @trustos/limits
 *
 * The limit engine: per-transaction, daily, monthly, rolling, wallet and organization limits.
 *
 * Two failure modes shape the design: checking without reserving lets two concurrent transactions
 * both pass, and counting the wrong window refuses a customer at 00:30 for yesterday's spending.
 * Both are addressed explicitly — read the header of `limits.ts`.
 */
export * from './limits';
export * from './testing';
