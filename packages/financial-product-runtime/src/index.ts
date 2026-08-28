/**
 * @trustos/financial-product-runtime
 *
 * The deterministic product runtime: block handlers, idempotency, rule evaluation, failure paths,
 * events and audit.
 *
 * `engine.ts` documents the thirteen steps every execution follows, in order, and the three
 * properties worth knowing before changing any of it: the runtime never re-resolves the active
 * version, it never authorizes, and a refusal is not a failure.
 *
 * **The framework ships no handler for any block.** `handlers.ts` is the contract; a deployment
 * binds each approved block to `@trustos/wallet`, `@trustos/ledger`, `@trustos/fees` and the
 * rest, and `@trustos/financial-product-sandbox` binds every one of them to a mock. The seam is
 * the deliverable.
 */
export * from './handlers';
export * from './idempotency';
export * from './engine';
