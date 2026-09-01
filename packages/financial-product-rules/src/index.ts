/**
 * @trustsystem/financial-product-rules
 *
 * The deterministic product rules engine: the fact map, the evaluation order, conflict
 * resolution and the explanation trace.
 *
 * The condition language is **not here**. It is `@trustsystem/workflow-definition`'s structured
 * predicate tree, and its header explains at length why a condition is a tree rather than an
 * expression string. What this package adds is the outcome side — the part that sets a fee,
 * imposes a limit, demands a review or refuses a transaction — plus the closed fact vocabulary
 * and the machinery that makes two rules disagreeing produce an answer somebody can defend.
 *
 * Read `facts.ts` before `engine.ts`. The reason the engine never sees an execution context is
 * the reason a rule cannot price by customer id, and it is easier to remove than to notice.
 */
export * from './facts';
export * from './engine';
export * from './validate';
