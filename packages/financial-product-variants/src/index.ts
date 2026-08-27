/**
 * @trustos/financial-product-variants
 *
 * Variants by controlled override, with provenance.
 *
 * A variant carries no blocks and no transitions, and the schema has no field for either. That
 * absence is the control: a variant that could reorder a limit check and a debit could remove the
 * limit check, and nothing in a variant review would show it.
 *
 * Read the header of `resolve.ts` for the three refusals — widening a jurisdiction list, weakening
 * a rule, removing a fee or limit — each of which would otherwise arrive looking like a
 * configuration change.
 */
export * from './variant';
export * from './resolve';
