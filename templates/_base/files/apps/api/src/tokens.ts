/**
 * Application injection tokens.
 *
 * Symbols rather than strings so two packages cannot collide on a token name,
 * and declared here rather than in each module so a consumer can depend on a
 * token without importing the module that provides it.
 */
export const APP_CONFIG_TOKEN = Symbol.for('product.config');
export const APP_LOGGER = Symbol.for('product.logger');
export const APP_METRICS = Symbol.for('product.metrics');
export const AUDIT_SERVICE = Symbol.for('product.audit-service');
export const AUTH_SERVICE = Symbol.for('product.auth-service');
