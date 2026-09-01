/**
 * @trustsystem/financial-product-core
 *
 * The vocabulary of the financial product composition layer: the definition document, the
 * lifecycle, the centrally governed reference data, the permission catalog, the rule shape and
 * the ports the runtime reaches the world through.
 *
 * Everything else in this layer is a function of what is declared here, which is why it is one
 * package rather than a field on whichever package happened to need it first. A definition owned
 * by the composer is a definition the runtime has to re-derive, and two derivations of the same
 * document disagree the first time a field is added.
 *
 * Read `definition.ts` first. The four conventions in its header — money as minor-unit strings,
 * rates as integers, provider interfaces rather than vendors, and everything declared rather than
 * implied — are the ones every other package in the layer assumes.
 */
export * from './ids';
export * from './errors';
export * from './reference-data';
export * from './lifecycle';
export * from './rules';
export * from './definition';
export * from './context';
export * from './permissions';
export * from './audit';
