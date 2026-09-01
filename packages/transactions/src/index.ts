/**
 * @trustsystem/transactions
 *
 * The transaction lifecycle: authorize, capture, complete, reverse and refund, with idempotency.
 *
 * A transaction is the *business* record of a movement; the journal is the accounting record. The
 * state machine is declared rather than implied, because the transition nobody thought about is
 * the one that lets a refunded transaction be captured again.
 */
export * from './transaction';
export * from './service';
export * from './testing';
