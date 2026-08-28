/**
 * @trustos/financial-events
 *
 * The financial event catalog: wallets, transactions, journals, settlement, fees, limits.
 *
 * Amounts travel as strings, never as numbers — a JSON number goes through a double each way, and
 * a subscriber totalling event payloads gets a figure that disagrees with the ledger. Events carry
 * ids and outcomes rather than balances, because a balance in an event is a stale balance.
 */
export * from './events';
