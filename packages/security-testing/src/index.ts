/**
 * @trustsystem/security-testing
 *
 * Helpers for the tests that matter: the ones where an almost-correct credential must
 * be refused.
 *
 * A suite that only checks the happy path proves a correct token is accepted, which
 * nobody doubted. `tokens.ts` makes each near-miss one line — wrong issuer, wrong
 * audience, expired, re-signed, `alg: none`, edited after signing — and
 * `assertions.ts` makes "no secret reached the log" a test rather than a claim.
 */
export * from './tokens';
export * from './assertions';
