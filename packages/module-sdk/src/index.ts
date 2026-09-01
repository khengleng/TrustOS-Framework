/**
 * @trustsystem/module-sdk
 *
 * The contract every TrustOS module implements.
 *
 * Read `defineModule` first: the invariants it enforces are the reason a module
 * cannot ship an unauthenticated route, a permission outside its namespace, a
 * configuration that has no safe default, or a data path that is not
 * organization-scoped.
 *
 * A module declares what it needs and receives everything through
 * `ModuleContext`. It never reads `process.env`, never builds a Prisma client,
 * never imports application code, and never reimplements framework behaviour —
 * see docs/module-development.md.
 */
export * from './metadata';
export * from './contracts';
export * from './context';
export * from './definition';
export * from './repository';
export * from './health';
export * from './testing';
