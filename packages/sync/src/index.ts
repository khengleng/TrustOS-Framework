/**
 * @trustsystem/sync
 *
 * Pull, push and bidirectional synchronization: incremental watermarks, conflict policies, run
 * history and a conflict log.
 *
 * No external provider is integrated here — `SyncConnector` is the seam, and a deployment
 * supplies it. Read the header of `sync.ts`: the watermark rules are the part that is silently
 * wrong when it is wrong.
 */
export * from './sync';
export * from './testing';
