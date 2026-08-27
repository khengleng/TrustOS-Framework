/**
 * @trustos/recovery
 *
 * Restore procedures, and the restore tests that turn a backup from a hypothesis into a capability.
 *
 * A restore test never targets production, its duration is measured rather than estimated, and a
 * check that was not performed is reported separately from one that failed — otherwise a test
 * passes by omitting the check it would have failed.
 */
export * from './recovery';
