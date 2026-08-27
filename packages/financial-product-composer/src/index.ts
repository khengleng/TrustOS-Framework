/**
 * @trustos/financial-product-composer
 *
 * The composer, the validator, the template library and the path an AI proposal takes to become
 * a draft.
 *
 * The validator is the part worth reading. Its header explains the three groups of finding, and
 * the third — **ordering** — is the reason the package exists: eight approved blocks connected by
 * legal transitions can still be a product that debits before it checks a limit, and the only
 * check that catches it is a dataflow analysis over what has definitely run on *every* path.
 *
 * The composer builds data and never behaviour. There is no `addScript` and no `addExpression`,
 * and adding one would make every review that followed a review of the wrong thing.
 */
export * from './validate';
export * from './composer';
export * from './templates';
export * from './ai-composition';
export * from './designer';
