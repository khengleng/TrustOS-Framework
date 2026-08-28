/**
 * @trustos/data-governance
 *
 * Ownership, residency, and the assessment that reports what is not in good standing.
 *
 * Every data-governance programme starts with a spreadsheet of owners and classifications,
 * maintained by hand, accurate on the day it is written. `assess` **derives** its findings from
 * the catalog, the retention rules and the residency policy, so a finding appears the moment the
 * thing it describes becomes true.
 *
 * Residency is a **hook**, not an enforcement point: this framework does not place data and will
 * not pretend to. It refuses a placement a deployment's tooling proposes, which is where the
 * decision is actually made.
 */
export * from './governance';
