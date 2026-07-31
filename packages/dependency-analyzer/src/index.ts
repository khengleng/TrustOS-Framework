/**
 * @trustos/dependency-analyzer
 *
 * Cycles, missing dependencies, version conflicts, unused modules, breaking changes and layering
 * violations across the module graph.
 *
 * Three of those six never fail at runtime. An unused module sits in a deployment enlarging its
 * attack surface and its upgrade cost; a layering violation accumulates until a layer cannot be
 * replaced. Nothing ever complains about either, which is the argument for a static analyzer.
 */
export * from './analyzer';
