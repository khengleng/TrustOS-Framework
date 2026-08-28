/**
 * @trustos/module-jobs
 *
 * A durable job queue in the database: leased execution, retry with backoff, priority, progress and history.
 *
 * The implementation lives in `@trustos/job-runtime`; this
 * package is the module contract around it.
 */
export * from './jobs.module';
