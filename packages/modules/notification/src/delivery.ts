/**
 * Delivery status and the retry queue.
 *
 * The state machine is declared as data rather than as `if` statements so it can
 * be asserted in a test and read by a reviewer. Two properties matter:
 *
 *   * terminal states have no outgoing transitions, so a message that was
 *     delivered can never be reported as pending again — every downstream count
 *     of "how many did we send" depends on that
 *   * `DEAD` is distinct from `FAILED`: failed means "will be retried", dead
 *     means "we stopped trying", and conflating them hides the second case
 */

export const DELIVERY_STATUSES = ['PENDING', 'SENT', 'FAILED', 'DEAD', 'CANCELLED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING: ['SENT', 'FAILED', 'CANCELLED'],
  // A failed message goes back to PENDING when it is retried.
  FAILED: ['PENDING', 'DEAD', 'CANCELLED'],
  SENT: [],
  DEAD: [],
  CANCELLED: [],
};

export const TERMINAL_DELIVERY_STATUSES: DeliveryStatus[] = ['SENT', 'DEAD', 'CANCELLED'];

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.includes(status);
}

/**
 * Backoff before attempt `attempt` (1-based).
 *
 * Exponential with a ceiling, and deterministic. Jitter is deliberately absent:
 * it belongs in a queue implementation that has many workers competing, and
 * putting it here would make every retry test non-reproducible for a benefit no
 * in-process queue receives.
 */
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

export function backoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  // 2 ** 20 * 30s already exceeds the ceiling; capping the exponent first keeps
  // the multiplication away from Infinity for an absurd attempt number.
  const scaled = BASE_BACKOFF_MS * 2 ** Math.min(exponent, 20);
  return Math.min(scaled, MAX_BACKOFF_MS);
}

export interface QueuedDelivery {
  messageId: string;
  organizationId: string;
  attempt: number;
  notBefore: Date;
}

/**
 * Where pending deliveries wait.
 *
 * A port rather than an implementation choice, because the in-memory queue below
 * is explicitly not a production queue: it is process-local, so a restart loses
 * whatever it held, and two instances each have their own. An application that
 * needs durability implements this interface over its own infrastructure — the
 * framework does not add Redis or Kafka (see docs/modules.md).
 */
export interface RetryQueue {
  enqueue(item: QueuedDelivery): Promise<void>;
  /** Items whose `notBefore` has passed, oldest first. Removed from the queue. */
  claimDue(now: Date, limit: number): Promise<QueuedDelivery[]>;
  size(): Promise<number>;
}

export class InMemoryRetryQueue implements RetryQueue {
  private items: QueuedDelivery[] = [];

  async enqueue(item: QueuedDelivery): Promise<void> {
    this.items.push({ ...item });
  }

  async claimDue(now: Date, limit: number): Promise<QueuedDelivery[]> {
    const due = this.items
      .filter((item) => item.notBefore.getTime() <= now.getTime())
      .sort((left, right) => left.notBefore.getTime() - right.notBefore.getTime())
      .slice(0, Math.max(0, limit));

    const claimed = new Set(due);
    this.items = this.items.filter((item) => !claimed.has(item));
    return due;
  }

  async size(): Promise<number> {
    return this.items.length;
  }

  /** Everything still waiting. Diagnostic, and used by the health indicator. */
  peek(): QueuedDelivery[] {
    return [...this.items];
  }
}
