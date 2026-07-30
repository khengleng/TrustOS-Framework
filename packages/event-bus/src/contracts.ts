import type { EventEnvelope } from '@trustos/event-sdk';
import type { RetryPolicy } from '@trustos/retry';

/**
 * The bus contract.
 *
 * The interface exists so the in-memory implementation is not the only possible one. A
 * deployment that outgrows a single process replaces `EventBus` with an adapter over whatever
 * broker it chose, and no publisher or subscriber changes — which is the whole reason this is an
 * interface rather than a class everybody imports.
 *
 * What the framework does **not** do is ship that adapter. No broker client is a dependency
 * here, and none will be: choosing one is a deployment decision with operational consequences,
 * and a framework that made it for you would be making it for every deployment.
 *
 * The guarantees an implementation must provide, and the reason each is a guarantee rather than
 * a nice-to-have:
 *
 *   * **At-least-once delivery.** A handler may see an event twice. Every real transport has
 *     this property, and pretending otherwise produces consumers that break the first time a
 *     retry happens. `deduplicationKey` is how a consumer copes.
 *   * **Ordering per aggregate, and only per aggregate.** Two events about one merchant arrive
 *     in order. Two about different merchants may not. A total order across the system is a
 *     throughput ceiling nobody asked for, and almost nobody actually needs it.
 *   * **Tenant isolation.** A subscriber scoped to an organization never receives another
 *     organization's event. Enforced by the bus, not by the handler — a handler that has to
 *     remember is a handler that eventually forgets.
 *   * **No unregistered event.** Publishing something the registry does not know throws.
 */

export type SubscriptionScope =
  /** Every event, both platform and tenant. For a framework-level subscriber: audit, metrics. */
  | { kind: 'platform' }
  /** One organization's events only. */
  | { kind: 'organization'; organizationId: string };

export interface EventHandlerContext {
  /** The event, payload already validated against its registered schema. */
  event: EventEnvelope;
  /** 1-based. Greater than 1 means this is a redelivery after a failure. */
  attempt: number;
  /**
   * What a handler should store to make itself idempotent.
   *
   * Scoped to this subscriber, so two subscribers each get their own chance at the event.
   */
  deduplicationKey: string;
  /** Cancelled on shutdown. A long handler should honour it. */
  signal: AbortSignal;
}

export type EventHandler = (context: EventHandlerContext) => Promise<void> | void;

export interface SubscriptionOptions {
  /**
   * Stable across restarts.
   *
   * Used for deduplication and dead-letter attribution, which means a generated id would make a
   * restart look like a new subscriber and replay everything it had already handled.
   */
  id: string;

  /** Event name patterns — see `matchesPattern` in `@trustos/event-sdk`. */
  events: string[];

  handler: EventHandler;

  scope?: SubscriptionScope;

  /** Defaults to the background preset. */
  retry?: RetryPolicy;

  /**
   * How many events this subscriber handles at once.
   *
   * 1 by default. A subscriber that writes to a database and has no idea it is running
   * concurrently is the common case, and the safe default is the one that does not surprise it.
   * Ordering per aggregate holds regardless of this setting.
   */
  concurrency?: number;

  /**
   * Whether a failure here should fail the publish call.
   *
   * False by default, and that default is the important part: a publisher is reporting a fact
   * that already happened, and one subscriber's bug must not roll back the caller's transaction
   * or return a 500 for work that succeeded. A failing subscriber goes to the dead-letter queue.
   *
   * True only for a subscriber that genuinely gates the operation — and if you find yourself
   * wanting that, what you want is probably a function call rather than an event.
   */
  blocking?: boolean;
}

export interface Subscription {
  readonly id: string;
  readonly events: readonly string[];
  unsubscribe(): void;
}

export interface PublishOptions {
  /** Waits for every non-blocking subscriber too. For tests, and for a batch job that needs quiet. */
  awaitDelivery?: boolean;
  signal?: AbortSignal;
}

export interface PublishResult {
  eventId: string;
  /** Subscribers matched. Zero is normal and is not an error — nobody may care yet. */
  matched: number;
  /** Handlers that completed. Only meaningful when the publish awaited delivery. */
  delivered: number;
  failed: number;
  warnings: string[];
}

export interface EventBus {
  publish<T>(event: EventEnvelope<T>, options?: PublishOptions): Promise<PublishResult>;

  /**
   * Publishes several events.
   *
   * Not a transaction — no transport this abstracts can promise that. What it does promise is
   * ordering: events sharing an aggregate are delivered in the order given, so a `created`
   * followed by an `updated` for one entity cannot arrive backwards.
   */
  publishBatch(events: EventEnvelope[], options?: PublishOptions): Promise<PublishResult[]>;

  subscribe(options: SubscriptionOptions): Subscription;
  unsubscribe(subscriptionId: string): boolean;

  /** Resolves when every in-flight handler has finished. For a graceful shutdown. */
  drain(timeoutMs?: number): Promise<void>;
}

/**
 * Where an event goes when a subscriber has exhausted its retries.
 *
 * A port rather than a table, because "keep it in memory" is right for a test and wrong for
 * production, and the framework should not decide which one a deployment is running.
 *
 * The thing that must not happen is the alternative: dropping it. An event that failed and
 * vanished is an invisible data-loss bug, and the first symptom is a customer noticing something
 * did not happen weeks later.
 */
export interface DeadLetterStore {
  record(entry: DeadLetterEntry): Promise<void>;
  list(filter: DeadLetterFilter): Promise<DeadLetterEntry[]>;
  get(id: string): Promise<DeadLetterEntry | null>;
  /** Marks it replayed. The entry is kept — a dead letter is a record of a failure that happened. */
  markReplayed(id: string, replayedById: string | null): Promise<void>;
}

export interface DeadLetterEntry {
  id: string;
  subscriptionId: string;
  organizationId: string | null;
  eventId: string;
  eventName: string;
  eventVersion: string;
  /** The whole envelope, redacted, so a replay does not need the original source. */
  envelope: EventEnvelope;
  attempts: number;
  error: string;
  failedAt: Date;
  replayedAt: Date | null;
  replayedById: string | null;
}

export interface DeadLetterFilter {
  organizationId?: string | null;
  subscriptionId?: string;
  eventName?: string;
  /** Excludes entries already replayed. */
  unreplayedOnly?: boolean;
  limit?: number;
}

/**
 * Remembers which events a subscriber has already handled.
 *
 * Optional. Without one the bus is at-least-once and a handler is responsible for its own
 * idempotency; with one the bus suppresses a duplicate before the handler sees it.
 *
 * `markHandled` returns whether this was the first time — a check-then-insert would race, and
 * the whole point is to be correct when two deliveries arrive at once. A database
 * implementation makes it an insert against a unique constraint, so the database decides the
 * winner rather than the application guessing.
 */
export interface DeliveryLedger {
  markHandled(key: string, event: { id: string; name: string }): Promise<boolean>;
  /** Housekeeping. A ledger that grows forever is a table nobody can query. */
  forgetOlderThan(cutoff: Date): Promise<number>;
}
