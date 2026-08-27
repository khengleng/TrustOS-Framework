/**
 * @trustos/financial-block-registry
 *
 * The approved catalog of reusable financial blocks, and the registry that resolves them.
 *
 * A product is composed from these and from nothing else. There is no block that runs a script,
 * calls a URL or evaluates an expression — the moment one exists, "products are composed from
 * approved capabilities" becomes "…and also arbitrary code", and every review that followed was
 * reviewing the wrong thing.
 *
 * Read the header of `catalog.ts` for why the catalog is local data rather than something
 * fetched, and `schema.ts` for the three refusals that catch a composition which is individually
 * valid and collectively wrong.
 *
 * **The framework ships no handler for any block here.** Every entry is a contract; the
 * deployment binds it to `@trustos/wallet`, `@trustos/ledger`, `@trustos/fees` and the rest, and
 * the sandbox binds it to mocks. The seam is the deliverable.
 */
export * from './schema';
export * from './catalog';
export * from './registry';
