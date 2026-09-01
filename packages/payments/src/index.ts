/**
 * @trustsystem/payments
 *
 * Payment requests: expiry, status, callbacks, idempotency and provider references.
 *
 * **No provider integrations.** A payment request is a claim on a payer, and it means the same
 * thing whether it is settled by card, by bank transfer or by cash at a counter. Every request
 * expires, and paying one is idempotent by construction.
 */
export * from './payment-request';
export * from './testing';
