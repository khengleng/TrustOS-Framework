/**
 * @trustos/policy-registry
 *
 * Policies as versioned, immutable documents.
 *
 * The framework's authorization engine already has policies as **code**, which is right for the
 * decisions that are part of the platform's own structure. This is for the other kind: the ones a
 * *deployment* changes without a release — "MFA above this amount", "this plan gets this quota",
 * "restricted exports need two approvals here and one there". Configuration with consequences,
 * which needs versions, approval and a decision log.
 *
 * The condition language is `@trustos/workflow-definition`'s predicate tree, imported whole. A
 * third condition language in this repository would be a third place to get it wrong.
 *
 * The default effect is `deny` and the schema refuses anything else. A policy whose default is
 * allow permits everything it did not think of, and those are exactly the interesting cases.
 */
export * from './registry';
