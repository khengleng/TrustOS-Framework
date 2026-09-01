/**
 * @trustsystem/job-runtime
 *
 * Background jobs: a durable queue in the database, a handler registry, and a worker that leases
 * what it runs. No queue broker — the database is already there and already backed up.
 *
 * `worker.ts`'s header explains the lease, which is the part that keeps a job from running twice
 * and the part most worth understanding before changing anything here.
 */
export * from './entities';
export * from './metrics';
export * from './queue';
export * from './registry';
export * from './testing';
export * from './worker';
