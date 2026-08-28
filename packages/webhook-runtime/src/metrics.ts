/** Metric names the webhook runtime emits. Constants, so a typo is not a silently empty graph. */
export const WEBHOOK_METRICS = {
  QUEUED: 'webhook.queued',
  /** Suppressed by the uniqueness constraint. Non-zero is the guarantee working, not a fault. */
  DUPLICATE_SUPPRESSED: 'webhook.duplicate_suppressed',
  DELIVERED: 'webhook.delivered',
  RETRY_SCHEDULED: 'webhook.retry_scheduled',
  /** The one to alert on: an event a receiver never got. */
  EXHAUSTED: 'webhook.exhausted',
  DURATION_MS: 'webhook.duration_ms',
  ENDPOINT_DISABLED: 'webhook.endpoint_disabled',
} as const;
