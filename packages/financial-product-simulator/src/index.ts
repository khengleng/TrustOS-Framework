/**
 * @trustos/financial-product-simulator
 *
 * Deterministic simulation at volume: path distribution, fee and limit totals, SLA timing and
 * exception counts.
 *
 * The measure worth running a simulation for is the **path distribution**. A product owner can
 * read a fee off a definition; what they cannot read is that 4% of transactions take the
 * enhanced-review branch, which is forty people a day at the volume they are planning.
 *
 * Two things the report deliberately does not claim, and states in its own `caveats`: the latency
 * figures are the runtime's own overhead because every provider is a mock, and a success rate is
 * a rate under the injected scenario mix rather than a reliability estimate.
 */
export * from './metrics';
export * from './simulator';
