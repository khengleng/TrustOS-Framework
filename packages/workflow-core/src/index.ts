/**
 * @trustsystem/workflow-core
 *
 * The workflow domain, as types plus the small number of pure functions every
 * workflow package needs. No runtime, no persistence, no framework binding — so
 * that the nine packages built on top of it can depend on the vocabulary without
 * depending on each other.
 *
 * Read `entities.ts` first. The two conventions that run through everything are
 * documented at the top of it: every tenant-owned record carries a non-null
 * `organizationId`, and states and actions are `string` rather than unions because
 * a definition declares its own.
 */
export * from './entities';
export * from './errors';
export * from './actor';
export * from './permissions';
