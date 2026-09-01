/**
 * @trustsystem/financial-core
 *
 * Money, currency, fixed-point decimals, rounding, allocation and financial identifiers.
 *
 * **No floating point.** An amount is a bigint of scaled units plus a scale, and every operation
 * is exact except division — which takes a rounding mode explicitly, because it is the only place
 * information is lost and losing it silently is how a rounding policy becomes an accident.
 *
 * Read the header of `decimal.ts` before changing anything here. The failure it prevents is not a
 * crash: it is a fee that agrees with every test and disagrees with the provider once in ten
 * thousand transactions.
 */
export * from './decimal';
export * from './money';
export * from './identifiers';
