/**
 * Injection tokens.
 *
 * Symbols rather than strings, so two packages cannot collide on a name, and declared here so a
 * consumer can depend on a token without importing what provides it.
 */
export const APP_CONFIG_TOKEN = Symbol.for('financial-product-admin.config');
export const APP_LOGGER = Symbol.for('financial-product-admin.logger');
export const SECURITY_POLICY = Symbol.for('financial-product-admin.security-policy');
export const SECURITY_EVENTS = Symbol.for('financial-product-admin.security-events');
export const AUDIT_SERVICE = Symbol.for('financial-product-admin.audit');
export const AUTHORIZER = Symbol.for('financial-product-admin.authorizer');
export const IDENTITY_PROVIDER = Symbol.for('financial-product-admin.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('financial-product-admin.access-resolver');

export const PRODUCT_REGISTRY = Symbol.for('financial-product-admin.registry');
export const PRODUCT_STORE = Symbol.for('financial-product-admin.store');
export const PRODUCT_RUNTIME = Symbol.for('financial-product-admin.runtime');
export const BLOCK_REGISTRY = Symbol.for('financial-product-admin.blocks');
export const CONNECTOR_REGISTRY = Symbol.for('financial-product-admin.connectors');
export const REFERENCE_DATA = Symbol.for('financial-product-admin.reference-data');
export const METRIC_COLLECTOR = Symbol.for('financial-product-admin.metrics');

/**
 * The registered global guards, in registration order.
 *
 * Published so a boot test can assert the order without reaching into Nest's container
 * internals. The order *is* the security model — see the header of
 * `financial-product-admin.module.ts`.
 */
export const GUARD_ORDER = Symbol.for('financial-product-admin.guard-order');
