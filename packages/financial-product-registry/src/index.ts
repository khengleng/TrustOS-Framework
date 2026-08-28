/**
 * @trustos/financial-product-registry
 *
 * The catalog: drafts, published versions, the active-version resolution every execution starts
 * from, and the tenant-scoped storage under all of it.
 *
 * `registry.ts` is the only place a product changes state, and its header documents the six steps
 * every method follows. Two of them are worth knowing before changing anything: the transition is
 * resolved against the lifecycle machine *before* authorization is asked, so a caller cannot
 * learn whether they would be permitted to do something the lifecycle does not allow; and every
 * write is conditional on the revision the read saw, so a decision made against a stale page is
 * refused rather than applied.
 *
 * `store.ts` is the contract a deployment binds to Prisma. Three of its methods say "must be
 * atomic", and they mean it in the sense phase 6 established.
 */
export * from './store';
export * from './registry';
export * from './catalog';
