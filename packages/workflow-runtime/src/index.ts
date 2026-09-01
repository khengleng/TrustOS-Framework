/**
 * @trustsystem/workflow-runtime
 *
 * The deterministic state machine, and the engine that drives it.
 *
 * Two files, and the split is deliberate. `machine.ts` is pure: given a definition, a
 * state, an action and data it returns the same answer every time, with no clock and no
 * database — which is what makes "is this transition legal" testable without a
 * transaction. `engine.ts` orchestrates persistence, authorization, tasks, SLAs and
 * history around it.
 *
 * The engine's header documents the six-step order every operation follows. Two of
 * those steps are worth knowing before changing anything: the transition is resolved
 * against the state machine *before* authorization is asked, so a caller cannot learn
 * whether they would be permitted to do something the workflow does not allow; and every
 * write is conditional on the version the read saw, so a decision made against a stale
 * page is refused rather than applied.
 */
export * from './machine';
export * from './idempotency';
export * from './engine';
export * from './definition-service';
export * from './prisma-stores';
export * from './in-memory-stores';
