/**
 * @trustos/financial-product-sandbox
 *
 * Isolated sandbox execution: a runtime wired entirely to mocks, synthetic balances, and a
 * scenario plan that makes a chosen block fail in a chosen way.
 *
 * **The sandbox has no path to production data**, and that is structural. It constructs its own
 * connector registry, idempotency store, event publisher and audit recorder, all in memory, and
 * there is no constructor parameter through which a production one could arrive. "The sandbox
 * must never use production credentials" is not a policy this package enforces; it is a sentence
 * that has nowhere to be violated.
 *
 * The *providers* are mocked and the *money* is not: balances and limits are computed with
 * `@trustos/financial-core`'s `Money`, because a sandbox that used floats would tell a product
 * owner something that disagrees with production once in ten thousand transactions.
 */
export * from './scenarios';
export * from './handlers';
export * from './sandbox';
