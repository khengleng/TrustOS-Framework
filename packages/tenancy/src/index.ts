/**
 * @trustos/tenancy
 *
 * Organization-based tenant isolation. Read docs/architecture.md ("Tenant
 * isolation rules") before changing anything in this package — its invariants
 * are the reason one customer cannot read another's data.
 */
export * from './tenant-context';
export * from './tenant-scope';
export * from './scoped-delegate';
export * from './nest/tenant.guard';
export * from './nest/decorators';
// Test doubles ship with the package so product code can prove its own
// tenant isolation without a database.
export * from './testing/fake-delegate';
