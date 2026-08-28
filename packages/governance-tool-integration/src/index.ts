/**
 * @trustos/governance-tool-integration
 *
 * The typed operations an internal application may call: a catalog, not a client.
 *
 * The gateway has to answer "is this path a real operation, and which resource does it touch" for
 * a request it has never seen. A set of functions cannot be asked that; a catalog can, and it is
 * what makes a console's declared actions checkable against something.
 *
 * **No business logic lives here.** Every entry is a mapping. A helper that computed a fee would
 * be a second implementation of the fee, in the layer specifically designated as not being the
 * system of record.
 */
export * from './operations';
