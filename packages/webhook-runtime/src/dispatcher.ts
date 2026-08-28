import { randomUUID } from 'node:crypto';
import type { LoggerPort } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import { matchesAny, redactEnvelope, serializeEvent, type EventEnvelope } from '@trustos/event-sdk';
import type { WebhookDeliveryStore, WebhookEndpointStore } from '@trustos/webhooks';
import { WEBHOOK_METRICS } from './metrics';

/**
 * Turning an event into deliveries.
 *
 * Subscribed to the bus, once, as a platform-scoped subscriber. Each matching endpoint gets one
 * queued delivery; the worker sends them.
 *
 * The rule the spec states — **never send duplicate webhook deliveries** — is enforced here, and
 * not by being careful. `enqueue` returns null when a row already exists for
 * `(endpointId, eventId)`, because that pair is a unique constraint in the database. Two
 * application instances handling the same event both call `enqueue`; one inserts, the other gets
 * null. A check-then-insert would let both win, and would do so precisely under the load where it
 * matters most.
 *
 * The other decision worth stating: **the body is built once, at queue time, and stored.** Every
 * retry sends the same bytes with the same signature. Rebuilding it per attempt would produce a
 * different signature for what the receiver sees as the same delivery — and a receiver that
 * caches the first signature would then reject every retry.
 */

export interface DispatcherOptions {
  endpoints: WebhookEndpointStore;
  deliveries: WebhookDeliveryStore;
  logger?: LoggerPort;
  metrics?: MetricsRecorder;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export interface DispatchResult {
  eventId: string;
  /** Endpoints whose subscription patterns matched. */
  matched: number;
  queued: number;
  /** Already queued by another instance. Not an error — it is the guarantee working. */
  duplicates: number;
  /** Matched but paused or disabled. */
  skipped: number;
}

export class WebhookDispatcher {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: DispatcherOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Queues a delivery per subscribed endpoint.
   *
   * Only the event's own organization is queried. A webhook that reached another tenant's
   * endpoint would be a data breach with a signature on it attesting that it came from us, and
   * the scoping is here rather than in the store so it cannot be forgotten by an implementation.
   */
  async dispatch(event: EventEnvelope): Promise<DispatchResult> {
    const candidates = await this.options.endpoints.findSubscribedTo(
      event.name,
      event.organizationId,
    );

    const matched = candidates.filter((endpoint) => matchesAny(event.name, endpoint.patterns));

    if (matched.length === 0) {
      return { eventId: event.id, matched: 0, queued: 0, duplicates: 0, skipped: 0 };
    }

    /*
     * The body, built once.
     *
     * Redacted first: a webhook body leaves the trust boundary entirely, and whatever is in it is
     * in a third party's logs within seconds. The redactor is a safety net over a payload that
     * should not have contained a secret in the first place — but this is the last place it can
     * be caught.
     */
    const body = serializeEvent(redactEnvelope(event));
    const signedAt = this.now();

    let queued = 0;
    let duplicates = 0;
    let skipped = 0;

    for (const endpoint of matched) {
      if (endpoint.status !== 'active') {
        skipped += 1;
        continue;
      }

      const delivery = await this.options.deliveries.enqueue({
        id: this.newId('whdl'),
        endpointId: endpoint.id,
        organizationId: event.organizationId,
        eventId: event.id,
        eventName: event.name,
        eventVersion: event.version,
        status: 'pending',
        attempts: 0,
        // Due immediately. The worker's poll interval is what actually spaces them out.
        nextAttemptAt: signedAt,
        responseStatus: null,
        responseBody: null,
        responseTimeMs: null,
        error: null,
        payload: body,
        signedAt,
        completedAt: null,
      });

      if (delivery === null) {
        // Another instance got there first. This is the uniqueness constraint doing its job, so
        // it is counted rather than logged as an error.
        duplicates += 1;
        this.options.metrics?.increment(WEBHOOK_METRICS.DUPLICATE_SUPPRESSED, 1, {
          event: event.name,
        });
        continue;
      }

      queued += 1;
    }

    this.options.metrics?.increment(WEBHOOK_METRICS.QUEUED, queued, { event: event.name });

    if (skipped > 0) {
      this.options.logger?.debug(
        { eventId: event.id, eventName: event.name, skipped },
        'webhook endpoints skipped because they are paused or disabled',
      );
    }

    return { eventId: event.id, matched: matched.length, queued, duplicates, skipped };
  }

  /**
   * The bus subscription options.
   *
   * A method rather than a constant so the id is stable and stated in one place: it is used for
   * deduplication and for dead-letter attribution, and a generated one would make every restart
   * look like a new subscriber.
   */
  subscriptionOptions(patterns: string[] = ['**']) {
    return {
      id: 'trustos.webhook-dispatcher',
      events: patterns,
      // Platform scope, because the dispatcher handles every tenant's events and does the tenant
      // scoping itself, per event, in `dispatch`.
      scope: { kind: 'platform' as const },
      handler: async ({ event }: { event: EventEnvelope }) => {
        await this.dispatch(event);
      },
    };
  }
}
