/**
 * @trustos/model-router
 *
 * Turns a requirement into a model, with fallbacks and tenant policy applied.
 *
 * Routing is deterministic: the same registry state, requirement and policy pick the same model
 * every time. A router that picked differently between two pods would turn a bug into one that
 * reproduces on one request in three.
 */
export * from './router';
