/**
 * @trustos/financial-product-governance
 *
 * Ownership, change classification, maker-checker approval requirements and the audit trail.
 *
 * The approval *models* are `@trustos/workflow-approvals`' and are not restated here. What this
 * package adds is the product-specific part: **which approval levels a change needs, derived from
 * what changed**. A product owner asked which approvals their change requires will answer with
 * the ones they remembered; a diff does not forget.
 *
 * Read `change-classification.ts` first — the classification is what every other decision in
 * governance is computed from, including the one in `@trustos/financial-product-state-machine`
 * about whether a lifecycle transition may proceed.
 */
export * from './change-classification';
export * from './governance';
export * from './maker-checker';
