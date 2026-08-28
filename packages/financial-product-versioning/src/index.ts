/**
 * @trustos/financial-product-versioning
 *
 * Immutable published versions, content hashing, version binding and rollback planning.
 *
 * One sentence carries the package: **a transaction started on v2.1 runs on v2.1 until it ends.**
 * Read the header of `binding.ts` for why — the short version is that a payment authorized at
 * 0.5% and captured after the rate moved must settle at 0.5%, and a system that re-resolved the
 * active version would charge the new rate, pass every test, and disagree with the merchant.
 *
 * `version.ts` documents the three layers that refuse an edit to a published version, and why the
 * third one — the content hash — is the one worth keeping when somebody argues the first two are
 * enough.
 */
export * from './version';
export * from './binding';
export * from './rollback';
