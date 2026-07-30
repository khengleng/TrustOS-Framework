/**
 * @trustos/token-meter
 *
 * Token estimation, context-window checks and estimate drift.
 *
 * Everything here is an **estimate** and says so in its name and its result. The only exact count
 * comes from the provider after the call; this is what lets a caller decide whether to make the
 * call at all.
 */
export * from './counter';
