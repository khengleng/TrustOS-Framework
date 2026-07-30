/**
 * @trustos/embedding
 *
 * Embedding provider abstraction with dimension, metric and version tracking.
 *
 * The tracking is the point: vectors from two different models are not comparable, and mixing
 * them in one index makes every similarity score meaningless with no symptom. The framework
 * ships no embedding provider.
 */
export * from './embedding';
