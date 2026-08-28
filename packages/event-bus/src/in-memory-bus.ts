import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { LoggerPort } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import type { EventRegistry } from '@trustos/event-registry';
import {
  assertValidPattern,
  deduplicationKey,
  matchesAny,
  orderingKey,
  redactEnvelope,
  type EventEnvelope,
} from '@trustos/event-sdk';
import {
  RETRY_PRESETS,
  RetryExhaustedError,
  RetryTimeoutError,
  withRetry,
  type RetryPolicy,
} from '@trustos/retry';
import type {
  DeadLetterStore,
  DeliveryLedger,
  EventBus,
  PublishOptions,
  PublishResult,
  Subscription,
  SubscriptionOptions,
  SubscriptionScope,
} from './contracts';
import { EVENT_BUS_METRICS } from './metrics';

/**
 * The in-memory bus. The default, and for most deployments the last one they need.
 *
 * A single process, no broker, no operational surface. That is not a limitation to apologise
 * for: a monolith publishing to itself gets ordering, retry, dead letters and tenant isolation
 * with nothing to install, and the day it outgrows that, the `EventBus` interface is what it
 * swaps.
 *
 * The four behaviours worth understanding before relying on it:
 *
 *   1. **Publish returns as soon as the event is accepted**, not when handlers finish. A
 *      publisher is reporting something that already happened; making it wait on a subscriber
 *      couples the two in exactly the way an event was supposed to avoid.
 *   2. **A failing subscriber does not fail the publish.** It retries, and then it dead-letters.
 *      The exception is `blocking: true`, which exists for the rare gate and is documented as
 *      the thing you probably do not want.
 *   3. **Ordering is per aggregate**, implemented as one promise chain per ordering key. Events
 *      about one merchant queue behind each other; events about different merchants do not.
 *   4. **The process boundary is the durability boundary.** Events in flight are lost on a
 *      crash. Said plainly here because the alternative — discovering it in production — is
 *      worse. A deployment that cannot accept that needs a durable transport behind the same
 *      interface, and the interface is why that is an adapter rather than a rewrite.
 */
export class InMemoryEventBus implements EventBus {
  private readonly subscriptions = new Map<string, InternalSubscription>();

  /**
   * One promise chain per ordering key, which is how ordering per aggregate is implemented.
   *
   * The entry is deleted once its chain settles and nothing has queued behind it — without that,
   * a long-running process accumulates one entry per aggregate it has ever seen, which is a
   * memory leak that only shows up after a month.
   */
  private readonly orderingChains = new Map<string, { tail: Promise<void>; depth: number }>();

  /** In-flight handler promises, so `drain` can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();

  private readonly shutdown = new AbortController();
  private closed = false;

  constructor(private readonly options: EventBusOptions) {}

  subscribe(options: SubscriptionOptions): Subscription {
    if (this.closed) {
      throw ApiError.conflict('The bus is shutting down and is not accepting subscriptions.', {
        reason: 'event_bus_closed',
      });
    }

    if (this.subscriptions.has(options.id)) {
      throw ApiError.conflict(
        `A subscription with id "${options.id}" already exists. Subscription ids are stable ` +
          'across restarts, so two subscribers sharing one would share a deduplication ledger.',
        { reason: 'subscription_conflict', subscriptionId: options.id },
      );
    }

    if (options.events.length === 0) {
      throw ApiError.validation(
        [
          {
            path: 'events',
            message: 'A subscription with no patterns would never receive anything.',
          },
        ],
        'This subscription has no event patterns.',
      );
    }

    for (const pattern of options.events) assertValidPattern(pattern);

    /*
     * Every pattern is checked against the registry.
     *
     * A subscription to an event that does not exist is almost always a typo, and the failure
     * mode without this check is silence — a handler that never runs, discovered when somebody
     * asks why the emails stopped. A wildcard is exempt: it is deliberately open-ended.
     */
    const unknown = options.events.filter(
      (pattern) => !pattern.includes('*') && !this.options.registry.has(pattern),
    );

    if (unknown.length > 0) {
      throw ApiError.validation(
        unknown.map((pattern) => ({
          path: 'events',
          message: `No schema is registered for "${pattern}". A subscription to an event that does not exist never fires.`,
        })),
        'This subscription refers to unregistered events.',
      );
    }

    const subscription: InternalSubscription = {
      id: options.id,
      events: options.events,
      handler: options.handler,
      scope: options.scope ?? { kind: 'platform' },
      retry: options.retry ?? RETRY_PRESETS.background,
      concurrency: Math.max(1, options.concurrency ?? 1),
      blocking: options.blocking ?? false,
      active: 0,
      queue: [],
    };

    this.subscriptions.set(options.id, subscription);
    this.options.logger?.debug(
      { subscriptionId: options.id, events: options.events },
      'event subscription registered',
    );

    return {
      id: options.id,
      events: options.events,
      unsubscribe: () => {
        this.unsubscribe(options.id);
      },
    };
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  async publish<T>(event: EventEnvelope<T>, options: PublishOptions = {}): Promise<PublishResult> {
    if (this.closed) {
      throw ApiError.conflict('The bus is shutting down and is not accepting events.', {
        reason: 'event_bus_closed',
      });
    }

    // Validation first, and it throws. An unregistered or malformed event is a publisher bug,
    // and the publisher is the only place it can be fixed — swallowing it here would move the
    // symptom to a consumer that did nothing wrong.
    const validated = this.options.registry.validate(event) as EventEnvelope<T>;
    const warnings = this.options.registry.warningsFor(validated);

    for (const warning of warnings) {
      this.options.logger?.warn({ eventId: validated.id, eventName: validated.name }, warning);
    }

    const matched = this.matchingSubscriptions(validated);

    this.options.metrics?.increment(EVENT_BUS_METRICS.PUBLISHED, 1, {
      event: validated.name,
      version: validated.version,
    });

    if (matched.length === 0) {
      // Not an error. An event nobody has subscribed to yet is the normal state of a system that
      // publishes facts rather than commands.
      this.options.metrics?.increment(EVENT_BUS_METRICS.UNMATCHED, 1, { event: validated.name });
      return { eventId: validated.id, matched: 0, delivered: 0, failed: 0, warnings };
    }

    const blocking = matched.filter((subscription) => subscription.blocking);
    const background = matched.filter((subscription) => !subscription.blocking);

    let delivered = 0;
    let failed = 0;

    // Blocking subscribers run before the publish returns, and a failure propagates. This is the
    // path that couples publisher to subscriber, and it is opt-in for exactly that reason.
    for (const subscription of blocking) {
      const outcome = await this.enqueue(subscription, validated, options.signal);
      if (outcome === 'delivered') delivered += 1;
      else failed += 1;
    }

    const backgroundWork = background.map((subscription) =>
      this.enqueue(subscription, validated, options.signal),
    );

    if (options.awaitDelivery) {
      for (const outcome of await Promise.all(backgroundWork)) {
        if (outcome === 'delivered') delivered += 1;
        else failed += 1;
      }
    } else {
      // Tracked so `drain` can wait, but not awaited here.
      for (const work of backgroundWork) this.track(work.then(() => undefined));
    }

    return { eventId: validated.id, matched: matched.length, delivered, failed, warnings };
  }

  /**
   * Publishes several events, preserving order within an aggregate.
   *
   * Sequential rather than parallel, which is the point: `Promise.all` over a batch would let a
   * `created` and an `updated` for one entity race, and a consumer receiving them backwards is a
   * bug that reproduces about one time in fifty.
   */
  async publishBatch(
    events: EventEnvelope[],
    options: PublishOptions = {},
  ): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    for (const event of events) results.push(await this.publish(event, options));
    return results;
  }

  /**
   * Which subscriptions want this event.
   *
   * Tenant scoping happens here rather than in the handler. A handler that has to remember to
   * check the organization is a handler that eventually forgets, and the failure is one tenant
   * reading another's data — the worst outcome available in this phase.
   */
  private matchingSubscriptions(event: EventEnvelope): InternalSubscription[] {
    return [...this.subscriptions.values()].filter(
      (subscription) =>
        matchesAny(event.name, subscription.events) &&
        isInScope(event.organizationId, subscription.scope),
    );
  }

  /**
   * Queues delivery, honouring both per-aggregate ordering and per-subscriber concurrency.
   *
   * Ordering is the outer constraint: an event with an ordering key chains behind the previous
   * event for that key, so two events about one merchant cannot overlap even if the subscriber
   * allows concurrency.
   */
  private enqueue(
    subscription: InternalSubscription,
    event: EventEnvelope,
    signal?: AbortSignal,
  ): Promise<'delivered' | 'failed'> {
    const key = orderingKey(event);
    if (!key) return this.runWithConcurrency(subscription, event, signal);

    // The chain is per subscriber *and* per aggregate: one slow subscriber must not hold up a
    // different subscriber's view of the same aggregate.
    const chainKey = `${subscription.id}|${key}`;
    const existing = this.orderingChains.get(chainKey);
    const depth = (existing?.depth ?? 0) + 1;

    let settle: (outcome: 'delivered' | 'failed') => void;
    const outcome = new Promise<'delivered' | 'failed'>((resolve) => {
      settle = resolve;
    });

    const tail = (existing?.tail ?? Promise.resolve())
      .then(() => this.runWithConcurrency(subscription, event, signal))
      .then(
        (result) => {
          settle(result);
        },
        () => {
          // A rejection here would poison the chain for every event behind it, so the chain
          // itself never rejects: failure is reported through `outcome`, and the next event for
          // this aggregate still gets its turn.
          settle('failed');
        },
      )
      .finally(() => {
        const current = this.orderingChains.get(chainKey);
        if (!current) return;
        current.depth -= 1;
        // Deleted when nothing is queued behind it. Otherwise a long-lived process keeps one
        // entry per aggregate it has ever seen.
        if (current.depth <= 0) this.orderingChains.delete(chainKey);
      });

    this.orderingChains.set(chainKey, { tail, depth });
    this.track(tail);

    return outcome;
  }

  /** Applies the subscriber's concurrency limit. */
  private runWithConcurrency(
    subscription: InternalSubscription,
    event: EventEnvelope,
    signal?: AbortSignal,
  ): Promise<'delivered' | 'failed'> {
    if (subscription.active < subscription.concurrency) {
      subscription.active += 1;
      return this.deliver(subscription, event, signal).finally(() => {
        subscription.active -= 1;
        subscription.queue.shift()?.();
      });
    }

    return new Promise<'delivered' | 'failed'>((resolve) => {
      subscription.queue.push(() => {
        subscription.active += 1;
        void this.deliver(subscription, event, signal)
          .finally(() => {
            subscription.active -= 1;
            subscription.queue.shift()?.();
          })
          .then(resolve);
      });
    });
  }

  /**
   * Runs one handler, with deduplication, retry and dead-lettering.
   *
   * Never throws. A publisher must not be broken by a subscriber, and the callers above rely on
   * this returning an outcome rather than raising.
   */
  private async deliver(
    subscription: InternalSubscription,
    event: EventEnvelope,
    signal?: AbortSignal,
  ): Promise<'delivered' | 'failed'> {
    const dedupeKey = deduplicationKey(event, subscription.id);

    if (this.options.ledger) {
      /*
       * Whether this is the first time.
       *
       * `markHandled` decides atomically and returns the answer, so two simultaneous deliveries
       * cannot both conclude they are first. A check-then-insert would be exactly the race the
       * ledger exists to close.
       *
       * A ledger failure lets the event through. The alternative — dropping it because the
       * bookkeeping is unavailable — trades an occasional duplicate for silent data loss, and a
       * duplicate is the failure a handler is already told to expect.
       */
      try {
        const first = await this.options.ledger.markHandled(dedupeKey, {
          id: event.id,
          name: event.name,
        });

        if (!first) {
          this.options.metrics?.increment(EVENT_BUS_METRICS.DEDUPLICATED, 1, {
            event: event.name,
            subscription: subscription.id,
          });
          return 'delivered';
        }
      } catch (error) {
        this.options.logger?.warn(
          {
            subscriptionId: subscription.id,
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'delivery ledger unavailable; delivering anyway',
        );
      }
    }

    const startedAt = Date.now();
    const linked = linkSignals(this.shutdown.signal, signal);

    try {
      const outcome = await withRetry(
        async (attempt) => {
          await subscription.handler({
            event,
            attempt,
            deduplicationKey: dedupeKey,
            signal: linked.signal,
          });
        },
        {
          operation: `event ${event.name} → ${subscription.id}`,
          policy: subscription.retry,
          signal: linked.signal,
          onRetry: (retryAttempt) => {
            this.options.metrics?.increment(EVENT_BUS_METRICS.RETRIED, 1, {
              event: event.name,
              subscription: subscription.id,
            });
            this.options.logger?.warn(
              {
                subscriptionId: subscription.id,
                eventId: event.id,
                eventName: event.name,
                attempt: retryAttempt.attempt,
                delayMs: retryAttempt.delayMs,
                error:
                  retryAttempt.error instanceof Error
                    ? retryAttempt.error.message
                    : String(retryAttempt.error),
              },
              'event handler failed; retrying',
            );
          },
        },
      );

      this.options.metrics?.observe(EVENT_BUS_METRICS.HANDLER_DURATION_MS, Date.now() - startedAt, {
        event: event.name,
        subscription: subscription.id,
      });
      this.options.metrics?.increment(EVENT_BUS_METRICS.DELIVERED, 1, {
        event: event.name,
        subscription: subscription.id,
        attempts: outcome.attempts,
      });

      return 'delivered';
    } catch (error) {
      await this.deadLetter(subscription, event, error);
      return 'failed';
    } finally {
      linked.dispose();
    }
  }

  /**
   * Records a permanently failed delivery.
   *
   * The envelope is redacted before it is stored. A dead letter is the longest-lived copy of an
   * event in the system — read by whoever debugs the failure months later, often exported into a
   * ticket — and a secret that reached it has reached everywhere.
   */
  private async deadLetter(
    subscription: InternalSubscription,
    event: EventEnvelope,
    error: unknown,
  ): Promise<void> {
    /*
     * The *original* error, not the retry wrapper.
     *
     * `RetryExhaustedError` reads "failed after 3 attempt(s)", which tells an operator nothing
     * they can act on. What they need is the message the handler actually threw, and the retry
     * package deliberately keeps it as `cause` for exactly this.
     *
     * The attempt count comes from the retry context rather than from the policy, because the
     * two differ whenever a non-retryable error stopped the loop early — and a dead letter
     * claiming three attempts when there was one sends somebody looking for a flaky downstream
     * that was never involved.
     */
    const { message, attempts } = describeFailure(error);

    this.options.metrics?.increment(EVENT_BUS_METRICS.DEAD_LETTERED, 1, {
      event: event.name,
      subscription: subscription.id,
    });

    this.options.logger?.error(
      {
        subscriptionId: subscription.id,
        eventId: event.id,
        eventName: event.name,
        organizationId: event.organizationId,
        error: message,
      },
      'event handler exhausted its retries',
    );

    if (!this.options.deadLetters) {
      // Said loudly, because an event that failed and vanished is invisible data loss and the
      // first symptom is a customer noticing weeks later.
      this.options.logger?.error(
        { eventId: event.id, subscriptionId: subscription.id },
        'no dead-letter store is configured, so this event is lost — configure one',
      );
      return;
    }

    try {
      await this.options.deadLetters.record({
        id: `dlq_${randomUUID()}`,
        subscriptionId: subscription.id,
        organizationId: event.organizationId,
        eventId: event.id,
        eventName: event.name,
        eventVersion: event.version,
        envelope: redactEnvelope(event),
        attempts,
        error: message.slice(0, 2000),
        failedAt: new Date(),
        replayedAt: null,
        replayedById: null,
      });
    } catch (storeError) {
      // The last line of defence. If the dead-letter store itself is down, the log is the only
      // remaining record that this event existed.
      this.options.logger?.error(
        {
          eventId: event.id,
          subscriptionId: subscription.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        },
        'the dead-letter store rejected an entry; the event is lost',
      );
    }
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.add(tracked);
    void tracked.finally(() => this.inFlight.delete(tracked));
  }

  /**
   * Waits for in-flight handlers.
   *
   * Called on shutdown. Without it, a process exits with handlers mid-flight and the events they
   * were working on are lost — which looks exactly like a bug in the handler.
   *
   * The timeout is a bound rather than a guarantee: a handler that ignores its abort signal
   * cannot be stopped, and waiting forever for one is how a deployment hangs.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    this.closed = true;

    const deadline = Date.now() + timeoutMs;

    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now()))),
      ]);
    }

    if (this.inFlight.size > 0) {
      this.options.logger?.warn(
        { remaining: this.inFlight.size, timeoutMs },
        'drain timed out with handlers still running',
      );
      // Signals the stragglers. A handler honouring its signal stops; one that does not is
      // beyond the bus's reach, and saying so is more useful than pretending otherwise.
      this.shutdown.abort();
    }
  }

  /** Introspection, for the health endpoint and the CLI. */
  describeSubscriptions(): Array<{
    id: string;
    events: readonly string[];
    scope: SubscriptionScope;
    concurrency: number;
    blocking: boolean;
    active: number;
    queued: number;
  }> {
    return [...this.subscriptions.values()].map((subscription) => ({
      id: subscription.id,
      events: subscription.events,
      scope: subscription.scope,
      concurrency: subscription.concurrency,
      blocking: subscription.blocking,
      active: subscription.active,
      queued: subscription.queue.length,
    }));
  }
}

/**
 * Unwraps a retry failure into the message and attempt count worth recording.
 *
 * Exported so the webhook and job runtimes report a failure the same way. Three places writing
 * their own version of this is three places where one of them stores the wrapper's message.
 */
export function describeFailure(error: unknown): { message: string; attempts: number } {
  if (error instanceof RetryExhaustedError || error instanceof RetryTimeoutError) {
    const original = error instanceof RetryExhaustedError ? error.cause : error;
    return {
      message: original instanceof Error ? original.message : String(original ?? error.message),
      attempts: error.context.attempts.length,
    };
  }

  // Not a retry failure at all: a non-retryable error rethrown as-is, which means exactly one
  // attempt happened.
  return { message: error instanceof Error ? error.message : String(error), attempts: 1 };
}

export interface EventBusOptions {
  registry: EventRegistry;
  deadLetters?: DeadLetterStore;
  ledger?: DeliveryLedger;
  logger?: LoggerPort;
  metrics?: MetricsRecorder;
}

interface InternalSubscription {
  id: string;
  events: string[];
  handler: SubscriptionOptions['handler'];
  scope: SubscriptionScope;
  retry: RetryPolicy;
  concurrency: number;
  blocking: boolean;
  active: number;
  queue: Array<() => void>;
}

/**
 * Whether an event is in a subscription's scope.
 *
 * A platform subscriber sees everything. An organization subscriber sees only its own — and
 * notably **not** platform events, whose `organizationId` is null: a tenant-scoped handler
 * receiving an event with no tenant has nothing to scope its work to, which is precisely how
 * one tenant's job ends up processing another's data.
 */
export function isInScope(organizationId: string | null, scope: SubscriptionScope): boolean {
  if (scope.kind === 'platform') return true;
  return organizationId !== null && organizationId === scope.organizationId;
}

/**
 * Combines the shutdown signal with a caller's.
 *
 * Returns a dispose function because the listener would otherwise stay on the long-lived
 * shutdown controller for the process's whole life — one leaked listener per event delivered,
 * which is a slow leak and a `MaxListenersExceededWarning` long before anybody looks.
 */
function linkSignals(
  shutdown: AbortSignal,
  caller?: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  /*
   * The common case: no caller signal, so there is nothing to combine and the shutdown signal is
   * already exactly what the handler should see.
   *
   * Worth the special case rather than always building a controller. A thousand concurrent
   * deliveries would otherwise attach a thousand listeners to one long-lived signal, which Node
   * reports as `MaxListenersExceededWarning` — a warning that is usually a leak and here would
   * be noise hiding a real one.
   */
  if (!caller) return { signal: shutdown, dispose: () => {} };

  const controller = new AbortController();
  const abort = () => controller.abort();

  if (shutdown.aborted || caller.aborted) controller.abort();
  else {
    shutdown.addEventListener('abort', abort, { once: true });
    caller.addEventListener('abort', abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      shutdown.removeEventListener('abort', abort);
      caller.removeEventListener('abort', abort);
    },
  };
}
