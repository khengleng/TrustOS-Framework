/**
 * @trustos/api-management
 *
 * The gate: catalog, entitlement, policy, rate, quota — in that order.
 *
 * The order is the contribution. Rate before quota, because a burst is not an exhausted
 * allowance. Quota last, because it is the only stage that costs the consumer something, and a
 * caller should never be billed for a call that was refused.
 */
export * from './management';
