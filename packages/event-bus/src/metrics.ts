/**
 * Metric names the bus emits.
 *
 * Constants rather than string literals at each call site, because a metric name typo is a
 * dashboard that is silently empty — and the graph looks the same as "nothing is failing".
 */
export const EVENT_BUS_METRICS = {
  PUBLISHED: 'event.bus.published',
  /** Published with no subscriber. Normal, but a sudden change is worth seeing. */
  UNMATCHED: 'event.bus.unmatched',
  DELIVERED: 'event.bus.delivered',
  RETRIED: 'event.bus.retried',
  /** Suppressed by the ledger as a repeat delivery. */
  DEDUPLICATED: 'event.bus.deduplicated',
  /** The one to alert on. A dead letter is work that did not happen. */
  DEAD_LETTERED: 'event.bus.dead_lettered',
  HANDLER_DURATION_MS: 'event.bus.handler_duration_ms',
} as const;
