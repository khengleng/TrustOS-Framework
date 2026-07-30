/**
 * @trustos/event-bus
 *
 * Publish, subscribe, ordering per aggregate, retry and dead letters — over an interface, with
 * an in-memory default.
 *
 * No broker client is a dependency here and none will be. Choosing one is a deployment decision
 * with operational consequences, and `EventBus` is the seam that keeps it a deployment decision
 * rather than a framework one. Read the header of `contracts.ts` for the guarantees an
 * implementation owes, and of `in-memory-bus.ts` for what the default does and does not survive.
 */
export * from './contracts';
export * from './in-memory-bus';
export * from './metrics';
export * from './replay';
export * from './stores';
export * from './nest/event-bus.module';
