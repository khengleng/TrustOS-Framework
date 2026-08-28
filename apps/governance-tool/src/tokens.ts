/** Injection tokens. Symbols, so two packages cannot collide on a name. */
export const APP_CONFIG_TOKEN = Symbol.for('governance-tool.config');
export const APP_LOGGER = Symbol.for('governance-tool.logger');
export const SECURITY_POLICY = Symbol.for('governance-tool.security-policy');
export const SECURITY_EVENTS = Symbol.for('governance-tool.security-events');
export const AUDIT_SERVICE = Symbol.for('governance-tool.audit');
export const AUTHORIZER = Symbol.for('governance-tool.authorizer');
export const IDENTITY_PROVIDER = Symbol.for('governance-tool.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('governance-tool.access-resolver');

export const APP_CATALOG = Symbol.for('governance-tool.app-catalog');
export const RESOURCE_REGISTRY = Symbol.for('governance-tool.resources');
export const ENVIRONMENT_REGISTRY = Symbol.for('governance-tool.environments');
export const GOVERNANCE_AUDIT = Symbol.for('governance-tool.governance-audit');
export const GOVERNANCE_RUNTIME = Symbol.for('governance-tool.runtime');
export const GATEWAY_ENVIRONMENT = Symbol.for('governance-tool.environment');
/** Issuer and client id the browser needs before it can start a login. Null without OIDC. */
export const PORTAL_CONFIG = Symbol.for('governance-tool.portal-config');

/** The registered global guards, in registration order. */
export const GUARD_ORDER = Symbol.for('governance-tool.guard-order');
