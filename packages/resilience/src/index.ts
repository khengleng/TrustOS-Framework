/**
 * @trustos/resilience
 *
 * Timeouts, retries, breakers, bulkheads and fallbacks — declared per dependency and reviewed
 * before the outage rather than chosen during it.
 *
 * The mechanisms come from `@trustos/retry`; what lives here is the declaration and the three
 * checks over it: a retry with no stated idempotency, a fallback the caller cannot detect, and a
 * budget that outlasts the caller's patience.
 */
export * from './resilience';
