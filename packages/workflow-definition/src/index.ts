/**
 * @trustos/workflow-definition
 *
 * The workflow definition document: its schema, its validator, the restricted
 * condition language, version comparison and static simulation.
 *
 * Two files are worth reading before changing anything here:
 *
 *   * `conditions.ts` explains why the condition language is a structured predicate
 *     tree rather than an expression string. The short version is that a condition
 *     is untrusted input that influences an authorization outcome, and every
 *     convenient alternative is a code-execution primitive.
 *   * `versioning.ts` explains why a published version never changes. A running
 *     instance reads its rules from a version row, so editing that row would
 *     retroactively change the rules a decision was made under.
 */
export * from './conditions';
export * from './schema';
export * from './validate';
export * from './versioning';
export * from './simulate';
export * from './examples';
