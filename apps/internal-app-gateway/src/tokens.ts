/** Injection tokens. Symbols, so two packages cannot collide on a name. */
export const APP_CONFIG_TOKEN = Symbol.for('internal-app-gateway.config');
export const APP_LOGGER = Symbol.for('internal-app-gateway.logger');
export const SECURITY_POLICY = Symbol.for('internal-app-gateway.security-policy');
export const SECURITY_EVENTS = Symbol.for('internal-app-gateway.security-events');
export const AUDIT_SERVICE = Symbol.for('internal-app-gateway.audit');
export const AUTHORIZER = Symbol.for('internal-app-gateway.authorizer');
export const IDENTITY_PROVIDER = Symbol.for('internal-app-gateway.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('internal-app-gateway.access-resolver');

export const RESOURCE_REGISTRY = Symbol.for('internal-app-gateway.resources');
export const ENVIRONMENT_REGISTRY = Symbol.for('internal-app-gateway.environments');
export const GOVERNANCE_AUDIT = Symbol.for('internal-app-gateway.governance-audit');
export const GOVERNANCE_RUNTIME = Symbol.for('internal-app-gateway.runtime');
export const APP_CATALOG = Symbol.for('internal-app-gateway.app-catalog');
export const MASK_POLICY = Symbol.for('internal-app-gateway.mask-policy');
export const RATE_LIMITER = Symbol.for('internal-app-gateway.rate-limiter');

/**
 * The registered global guards, in registration order.
 *
 * Published so the boot test asserts the order itself rather than a restatement of it.
 */
export const GUARD_ORDER = Symbol.for('internal-app-gateway.guard-order');
