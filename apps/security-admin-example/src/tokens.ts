/**
 * Injection tokens.
 *
 * Symbols rather than strings so two packages cannot collide on a name, and declared
 * here so a consumer can depend on a token without importing what provides it.
 */
export const APP_CONFIG_TOKEN = Symbol.for('security-admin.config');
export const APP_LOGGER = Symbol.for('security-admin.logger');
export const SECURITY_POLICY = Symbol.for('security-admin.policy');
export const SECURITY_EVENTS = Symbol.for('security-admin.security-events');
export const IDENTITY_PROVIDER = Symbol.for('security-admin.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('security-admin.access-resolver');
export const SESSION_SERVICE = Symbol.for('security-admin.session-service');
export const API_KEY_SERVICE = Symbol.for('security-admin.api-key-service');
export const SERVICE_ACCOUNT_SERVICE = Symbol.for('security-admin.service-account-service');
export const AUTHORIZER = Symbol.for('security-admin.authorizer');
export const AUDIT_SERVICE = Symbol.for('security-admin.audit-service');

/**
 * The registered global guards, in registration order.
 *
 * Published so a boot test can assert on the order without reaching into Nest's
 * container internals. The order *is* the security model — see the header of
 * `security-admin.module.ts`.
 */
export const GUARD_ORDER = Symbol.for('security-admin.guard-order');
