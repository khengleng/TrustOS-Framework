/**
 * @trustsystem/module-events
 *
 * Typed, versioned domain events with a schema registry, ordering per aggregate, retry, dead letters and replay.
 *
 * The implementation lives in `@trustsystem/event-bus`, `@trustsystem/event-registry`, `@trustsystem/event-sdk`; this
 * package is the module contract around it.
 */
export * from './events.module';
