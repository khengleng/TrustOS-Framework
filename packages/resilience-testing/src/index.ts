/**
 * @trustsystem/resilience-testing
 *
 * Controlled failure injection: what may be tested, where, by whose approval, and what may never
 * be tested automatically.
 *
 * Destructive faults cannot run against production under any configuration. There is no correct
 * value for "who may corrupt the production ledger to see what happens", and offering the setting
 * is how it eventually gets set.
 */
export * from './testing';
