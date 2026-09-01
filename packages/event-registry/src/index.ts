/**
 * @trustsystem/event-registry
 *
 * The versioned schema catalog. An event whose schema is not registered is never published —
 * that single rule is what turns a bus from a place where anything can appear into a contract.
 */
export * from './registry';
export * from './standard-events';
