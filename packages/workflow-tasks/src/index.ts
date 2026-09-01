/**
 * @trustsystem/workflow-tasks
 *
 * Tasks, assignment and the concurrency that makes a shared queue work.
 *
 * The one property this package exists to guarantee: two users must not both succeed
 * at claiming the same task. The header of `service.ts` explains why that needs a
 * conditional update in the store rather than a check in the service, and why
 * `TaskStore.claim` returning null is the signal that somebody else won.
 */
export * from './assignment';
export * from './service';
export * from './prisma-store';
