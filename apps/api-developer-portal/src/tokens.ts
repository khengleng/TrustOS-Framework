/**
 * Injection tokens.
 */
export const APP_CONFIG_TOKEN = Symbol.for('api-developer-portal.config');
export const APP_LOGGER = Symbol.for('api-developer-portal.logger');
export const SECURITY_POLICY = Symbol.for('api-developer-portal.security-policy');
export const SECURITY_EVENTS = Symbol.for('api-developer-portal.security-events');
export const AUDIT_SERVICE = Symbol.for('api-developer-portal.audit');
export const AUTHORIZER = Symbol.for('api-developer-portal.authorizer');
export const IDENTITY_PROVIDER = Symbol.for('api-developer-portal.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('api-developer-portal.access-resolver');

export const API_CATALOG = Symbol.for('api-developer-portal.catalog');
export const CONSUMER_REGISTRY = Symbol.for('api-developer-portal.consumers');
export const PORTAL_STATE = Symbol.for('api-developer-portal.state');
export const QUOTA_STORE = Symbol.for('api-developer-portal.quota-store');
/** Reads credential metadata from the deployment's key store. Never a key. */
export const KEY_METADATA = Symbol.for('api-developer-portal.key-metadata');

/** Registered global guards, in registration order. */
export const GUARD_ORDER = Symbol.for('api-developer-portal.guard-order');
