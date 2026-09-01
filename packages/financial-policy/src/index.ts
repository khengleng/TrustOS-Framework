/**
 * @trustsystem/financial-policy
 *
 * Per-tenant financial policy: allowed currencies, overdraft, approval thresholds, settlement.
 *
 * Policies are never merged — the most specific one applies whole, so "why was this allowed" has
 * one answer. An empty currency list means none rather than all, because an unconfigured platform
 * that accepted every currency would produce balances nobody can settle.
 */
export * from './policy';
