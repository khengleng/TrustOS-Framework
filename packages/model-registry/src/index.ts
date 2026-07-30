/**
 * @trustos/model-registry
 *
 * The catalog of models: capabilities, context windows, pricing, availability.
 *
 * The framework ships **no model definitions**. Prices change monthly and availability varies by
 * account, so a catalog baked into a framework is wrong for most deployments and stale for the
 * rest. This is the shape; the entries are configuration.
 */
export * from './model';
export * from './registry';
