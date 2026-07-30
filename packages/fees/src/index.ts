/**
 * @trustos/fees
 *
 * The fee engine: flat, percentage, tiered, capped, tax, discount and promotional fees.
 *
 * Two things matter more than the arithmetic. A published schedule is immutable and versioned, so
 * last month's invoice re-prices to the same number. And every computed fee shows its working, so
 * "why is this 2.47" has an answer nobody has to re-derive.
 */
export * from './schedule';
export * from './testing';
