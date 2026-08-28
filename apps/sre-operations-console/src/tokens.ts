/**
 * Injection tokens.
 */
export const APP_CONFIG_TOKEN = Symbol.for('sre-operations-console.config');
export const APP_LOGGER = Symbol.for('sre-operations-console.logger');
export const SECURITY_POLICY = Symbol.for('sre-operations-console.security-policy');
export const SECURITY_EVENTS = Symbol.for('sre-operations-console.security-events');
export const AUDIT_SERVICE = Symbol.for('sre-operations-console.audit');
export const AUTHORIZER = Symbol.for('sre-operations-console.authorizer');
export const IDENTITY_PROVIDER = Symbol.for('sre-operations-console.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('sre-operations-console.access-resolver');

export const SERVICE_REGISTRY = Symbol.for('sre-operations-console.services');
export const HEALTH_BOARD = Symbol.for('sre-operations-console.health');
export const SLI_REGISTRY = Symbol.for('sre-operations-console.slis');
export const SRE_STATE = Symbol.for('sre-operations-console.state');
export const INCIDENT_MANAGER = Symbol.for('sre-operations-console.incidents');
export const INCIDENT_SINK = Symbol.for('sre-operations-console.incident-sink');

/** Registered global guards, in registration order. */
export const GUARD_ORDER = Symbol.for('sre-operations-console.guard-order');
