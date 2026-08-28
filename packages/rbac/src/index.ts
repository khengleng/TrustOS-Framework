/**
 * @trustos/rbac
 *
 * Roles, permissions, and the deny-by-default guard that enforces them.
 * Depends only on @trustos/errors and @trustos/shared-types, so authorization
 * rules stay testable without a database or an HTTP server.
 */
export * from './permissions';
export * from './roles';
export * from './permission-checker';
export * from './nest/metadata';
export * from './nest/decorators';
export * from './nest/permissions.guard';
