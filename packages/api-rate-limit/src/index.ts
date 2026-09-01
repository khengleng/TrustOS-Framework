/**
 * @trustsystem/api-rate-limit
 *
 * How fast a caller may arrive, per second, minute, hour or day, with burst.
 *
 * Separate from quota on purpose: a rate limit protects the service's capacity, a quota protects
 * the commercial arrangement. Conflating them refuses a consumer who paid for a million monthly
 * calls because they made forty in a second, and tells them their quota is exhausted.
 */
export * from './rate-limit';
