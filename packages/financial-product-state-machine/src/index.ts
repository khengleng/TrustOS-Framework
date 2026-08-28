/**
 * @trustos/financial-product-state-machine
 *
 * Two deterministic state machines: the governance lifecycle a product definition passes
 * through, and the execution states one transaction passes through.
 *
 * Both are declared tables rather than a set of service methods, for the reason every state
 * machine in this framework is: the transition nobody thought about is the one that lets a draft
 * reach production, and it is invisible in a service and obvious in a table.
 *
 * `machine.ts` is pure — no clock, no store, no authorization. `checkLifecycleTransition` is
 * where the world comes in, and its four preconditions are stated separately for exactly that
 * reason.
 */
export * from './machine';
export * from './lifecycle-machine';
export * from './runtime-machine';
