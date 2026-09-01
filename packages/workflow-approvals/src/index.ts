/**
 * @trustsystem/workflow-approvals
 *
 * The six approval models, as pure functions of the decision trail.
 *
 * Nothing here holds state. Approval progress is *derived* from the decisions
 * already recorded rather than tracked alongside them, so the two cannot disagree —
 * the alternative is the design that produces "the instance says 2 of 3 but only one
 * decision exists". Read the header of `models.ts` before changing any of it.
 */
export * from './models';
