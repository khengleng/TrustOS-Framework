/**
 * @trustos/license-manager
 *
 * Licence tiers, feature entitlements, validation and expiry.
 *
 * Three rules the implementation is built around. A licence gates commercial features, never
 * security ones — audit, tenant isolation and RBAC are not entitlements, because a framework that
 * puts authentication behind a paid tier produces deployments that turn it off. Expiry degrades
 * rather than detonates: an expired licence stops new privileged operations and leaves the running
 * system running. And validation is offline, because a licence server is a kill switch operated by
 * whoever controls the network.
 */
export * from './license';
