/**
 * @trustsystem/api-quota
 *
 * How much a consumer may use over a calendar period, and what happens past it.
 *
 * Usage is recorded per call, never sampled or extrapolated: a quota that says "approximately
 * 840,000 calls" cannot be reconciled with an invoice, and the first dispute makes that everyone's
 * problem. Overage prices are minor-unit strings and arithmetic is BigInt.
 */
export * from './quota';
