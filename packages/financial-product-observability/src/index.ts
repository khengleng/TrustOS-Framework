/**
 * @trustsystem/financial-product-observability
 *
 * The product metric catalog, the collector the runtime reports through, and the dashboard
 * descriptors the admin renders.
 *
 * The catalog's header is the part to read: **a metric dimension is a cardinality decision**, and
 * one dimension carrying a customer id is both the largest line in an infrastructure bill and a
 * list of customers in a system with no access control on it. `assertLowCardinality` refuses one
 * at emission rather than at review, because a dimension added during an incident is a dimension
 * nobody reviews.
 */
export * from './metrics';
export * from './collector';
export * from './dashboards';
