/**
 * Injection tokens.
 *
 * Symbols rather than strings, so two packages cannot collide on a name.
 */
export const APP_CONFIG_TOKEN = Symbol.for('enterprise-governance-admin.config');
export const APP_LOGGER = Symbol.for('enterprise-governance-admin.logger');
export const SECURITY_POLICY = Symbol.for('enterprise-governance-admin.security-policy');
export const SECURITY_EVENTS = Symbol.for('enterprise-governance-admin.security-events');
export const AUDIT_SERVICE = Symbol.for('enterprise-governance-admin.audit');
export const AUTHORIZER = Symbol.for('enterprise-governance-admin.authorizer');
export const IDENTITY_PROVIDER = Symbol.for('enterprise-governance-admin.identity-provider');
export const ACCESS_RESOLVER = Symbol.for('enterprise-governance-admin.access-resolver');

export const DATA_CATALOG = Symbol.for('enterprise-governance-admin.data-catalog');
export const LINEAGE_GRAPH = Symbol.for('enterprise-governance-admin.lineage');
export const POLICY_ENGINE = Symbol.for('enterprise-governance-admin.policy-engine');
export const POLICY_REGISTRY = Symbol.for('enterprise-governance-admin.policy-registry');
export const SERVICE_REGISTRY = Symbol.for('enterprise-governance-admin.service-registry');
export const API_CATALOG = Symbol.for('enterprise-governance-admin.api-catalog');
export const CONSUMER_REGISTRY = Symbol.for('enterprise-governance-admin.consumers');
export const BACKUP_INVENTORY = Symbol.for('enterprise-governance-admin.backups');
export const CONTINUITY_STATE = Symbol.for('enterprise-governance-admin.continuity');

/**
 * The registered global guards, in registration order.
 *
 * Published so the boot test can assert the order without reaching into Nest's container.
 */
export const GUARD_ORDER = Symbol.for('enterprise-governance-admin.guard-order');
