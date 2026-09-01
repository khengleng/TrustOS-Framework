/**
 * @trustsystem/wallet
 *
 * Ledger-backed wallets: available, held and reserved balances, freeze, holds and history.
 *
 * A wallet is a **view over ledger accounts**, not a balance of its own. A wallet with its own
 * balance column has two sources of truth, they disagree within a month, and the one everybody
 * reads is the wrong one.
 */
export * from './wallet';
export * from './service';
export * from './testing';
