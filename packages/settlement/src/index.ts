/**
 * @trustsystem/settlement
 *
 * Settlement batches, instructions, windows and adjustments. Asynchronous by construction.
 *
 * The settlement account is the whole mechanism: money leaves a merchant and lands in transit, and
 * leaves there only when the counterparty confirms. That balance is exactly what has left and not
 * arrived, and it is checkable against a bank statement.
 */
export * from './settlement';
export * from './testing';
