/** Metric names the job runtime emits. */
export const JOB_METRICS = {
  ENQUEUED: 'job.enqueued',
  SUCCEEDED: 'job.succeeded',
  RETRIED: 'job.retried',
  /** The one to alert on: work that will not happen without intervention. */
  FAILED: 'job.failed',
  CANCELLED: 'job.cancelled',
  /** A run discarded because another worker took the job. Non-zero means leases are too short. */
  LEASE_LOST: 'job.lease_lost',
  DURATION_MS: 'job.duration_ms',
  /** Queue depth. The number that tells you whether workers are keeping up. */
  QUEUE_DEPTH: 'job.queue_depth',
} as const;
