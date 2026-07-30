/**
 * @trustos/authorization
 *
 * Policy-based authorization over RBAC. Default deny.
 *
 * Read `policies.ts` first: the built-in set is ordered, every policy except the
 * last can only *deny*, and `rbac.permission` is the only one that allows. That
 * shape is what makes the set safe to extend — a new policy can only narrow access.
 */
export * from './decision';
export * from './policies';
export * from './authorizer';
