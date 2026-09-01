/**
 * @trustsystem/dependency-health
 *
 * Four health states, derived on read against a freshness budget.
 *
 * `UNKNOWN` is a failure to observe, not a guess at success: carrying the last known-good state
 * forward would render a monitoring outage as a healthy estate.
 */
export * from './health';
