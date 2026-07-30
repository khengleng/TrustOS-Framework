import { randomUUID } from 'node:crypto';
import type { LoggerPort } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import { RETRY_PRESETS, backoffDelay, type RetryPolicy } from '@trustos/retry';
import type { WebhookDelivery, WebhookDeliveryStore, WebhookService } from '@trustos/webhooks';
import { deliverWebhook, type DeliveryOutcome } from './delivery';
import type { DestinationPolicy } from './destination';
import { WEBHOOK_METRICS } from './metrics';

/**
 * The delivery worker.
 *
 * Polls for due deliveries, sends them, schedules the next attempt or gives up. A loop rather
 * than a queue library, because the queue is the database — and one durable store that is already
 * backed up is better operationally than a second one that is not.
 *
 * Three properties it must have, and how each is achieved:
 *
 *   * **Two workers must not send the same delivery twice.** `claimDue` is an atomic claim, not a
 *     read. Everything else here assumes that; a store that implements it as a plain `SELECT`
 *     will double-send under any real load, which is why the port documents it in capitals.
 *   * **A slow endpoint must not starve the others.** Deliveries run concurrently up to a limit,
 *     so one receiver taking fifteen seconds does not hold up a hundred that take fifty
 *     milliseconds.
 *   * **Shutdown finishes in flight work.** `stop()` waits. A process killed mid-delivery leaves
 *     a row claimed and never completed, which needs a reaper to recover — and reapers are how
 *     "at least once" quietly becomes "sometimes never".
 */

export interface WorkerOptions {
  deliveries: WebhookDeliveryStore;
  /** Provides signing secrets and records endpoint health. */
  webhooks: Pick<WebhookService, 'signingSecrets' | 'recordOutcome' | 'getEndpoint'>;

  /** Defaults to the webhook preset: 8 attempts spread over roughly an hour. */
  retry?: RetryPolicy;
  /** How often to poll when the last poll found nothing. */
  pollIntervalMs?: number;
  /** How many deliveries to claim per poll. */
  batchSize?: number;
  /** How many to send at once. */
  concurrency?: number;
  timeoutMs?: number;
  destinationPolicy?: DestinationPolicy;

  logger?: LoggerPort;
  metrics?: MetricsRecorder;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** Identifies this worker in the claim, so a stuck claim can be attributed. */
  workerId?: string;
}

export class WebhookWorker {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly workerId: string;
  private readonly retry: RetryPolicy;

  private running = false;
  private loop: Promise<void> | null = null;
  private readonly stopSignal = new AbortController();

  constructor(private readonly options: WorkerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
    this.retry = options.retry ?? RETRY_PRESETS.webhook;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * Stops, waiting for in-flight deliveries.
   *
   * The wait is the point. Exiting immediately leaves rows claimed by a worker that no longer
   * exists, and recovering them needs a reaper with a timeout — which means a genuinely stuck
   * delivery is indistinguishable from a slow one.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal.abort();
    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;

    while (this.running) {
      let processed = 0;

      try {
        processed = await this.tick();
      } catch (error) {
        // The loop must not die. A store that is briefly unavailable would otherwise stop webhook
        // delivery for the life of the process, and the symptom is silence.
        this.options.logger?.error(
          {
            workerId: this.workerId,
            error: error instanceof Error ? error.message : String(error),
          },
          'webhook worker tick failed',
        );
      }

      // No wait when the last batch was full: there is probably more waiting, and sleeping a
      // second per batch would cap throughput at `batchSize` per second regardless of capacity.
      if (processed === 0 && this.running) {
        await this.sleep(pollIntervalMs);
      }
    }
  }

  /** One poll. Exposed so a test — or a deployment running the worker from a cron — can drive it. */
  async tick(): Promise<number> {
    const batchSize = this.options.batchSize ?? 20;
    const concurrency = this.options.concurrency ?? 5;

    const due = await this.options.deliveries.claimDue({
      now: this.now(),
      limit: batchSize,
      workerId: this.workerId,
    });

    if (due.length === 0) return 0;

    // A simple fixed-size pool: `concurrency` runners pulling from a shared cursor. Cheaper than
    // a semaphore per item and the ordering does not matter — two deliveries to different
    // endpoints are independent by definition.
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, due.length) }, async () => {
      while (cursor < due.length) {
        const delivery = due[cursor];
        cursor += 1;
        if (!delivery) break;
        await this.process(delivery);
      }
    });

    await Promise.all(runners);
    return due.length;
  }

  /** Sends one delivery and records what happened. Never throws. */
  private async process(delivery: WebhookDelivery): Promise<void> {
    const attempt = delivery.attempts + 1;
    const startedAt = this.now();

    let outcome: DeliveryOutcome;

    try {
      const endpoint = await this.options.webhooks.getEndpoint(
        delivery.endpointId,
        delivery.organizationId,
      );

      const secrets = await this.options.webhooks.signingSecrets(
        delivery.endpointId,
        delivery.organizationId,
      );

      if (secrets.length === 0) {
        // Nothing to sign with. Not retryable: it will still be true next time, and an unsigned
        // delivery is not an option — a receiver cannot verify it and should not accept it.
        outcome = {
          succeeded: false,
          responseStatus: null,
          responseBody: null,
          durationMs: 0,
          error: 'No active signing secret for this endpoint.',
          retryable: false,
          gone: false,
        };
      } else {
        outcome = await deliverWebhook({
          deliveryId: delivery.id,
          url: endpoint.url,
          // The stored body, byte for byte. Rebuilding it would change the signature between
          // attempts of what the receiver sees as one delivery.
          body: delivery.payload,
          eventName: delivery.eventName,
          secrets,
          timeoutMs: this.options.timeoutMs,
          destinationPolicy: this.options.destinationPolicy,
          // The worker's clock, not the ambient one. The delivery timestamp is *signed*, so a
          // second clock here would produce a signature that verifies against a different time
          // than everything else in the worker believes it is — which is exactly the kind of
          // discrepancy that only shows up as "the receiver rejects everything".
          now: () => this.now().getTime(),
        });
      }
    } catch (error) {
      outcome = {
        succeeded: false,
        responseStatus: null,
        responseBody: null,
        durationMs: this.now().getTime() - startedAt.getTime(),
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
        gone: false,
      };
    }

    await this.recordAttempt(delivery, attempt, startedAt, outcome);
  }

  private async recordAttempt(
    delivery: WebhookDelivery,
    attempt: number,
    startedAt: Date,
    outcome: DeliveryOutcome,
  ): Promise<void> {
    await this.options.deliveries.recordAttempt({
      id: this.newId('what'),
      deliveryId: delivery.id,
      organizationId: delivery.organizationId,
      attempt,
      startedAt,
      durationMs: outcome.durationMs,
      responseStatus: outcome.responseStatus,
      error: outcome.error,
      outcome: outcome.succeeded ? 'succeeded' : 'failed',
    });

    this.options.metrics?.observe(WEBHOOK_METRICS.DURATION_MS, outcome.durationMs, {
      event: delivery.eventName,
      status: outcome.responseStatus ?? 0,
    });

    if (outcome.succeeded) {
      await this.options.deliveries.markResult(delivery.id, {
        status: 'succeeded',
        attempts: attempt,
        nextAttemptAt: null,
        responseStatus: outcome.responseStatus,
        responseBody: outcome.responseBody,
        responseTimeMs: outcome.durationMs,
        error: null,
        completedAt: this.now(),
      });

      await this.options.webhooks.recordOutcome(delivery.endpointId, delivery.organizationId, {
        succeeded: true,
      });

      this.options.metrics?.increment(WEBHOOK_METRICS.DELIVERED, 1, { event: delivery.eventName });
      return;
    }

    const exhausted = attempt > this.retry.maxAttempts;
    const giveUp = exhausted || !outcome.retryable || outcome.gone;

    if (giveUp) {
      await this.options.deliveries.markResult(delivery.id, {
        status: 'exhausted',
        attempts: attempt,
        nextAttemptAt: null,
        responseStatus: outcome.responseStatus,
        responseBody: outcome.responseBody,
        responseTimeMs: outcome.durationMs,
        error: outcome.error,
        completedAt: this.now(),
      });

      await this.options.webhooks.recordOutcome(delivery.endpointId, delivery.organizationId, {
        succeeded: false,
        reason: outcome.error ?? 'unknown',
        // A 410 disables at once rather than counting towards a threshold: the receiver has said
        // stop, and continuing would ignore an explicit instruction.
        disableImmediately: outcome.gone,
      });

      this.options.metrics?.increment(WEBHOOK_METRICS.EXHAUSTED, 1, {
        event: delivery.eventName,
        reason: outcome.gone ? 'gone' : exhausted ? 'retries_exhausted' : 'not_retryable',
      });

      this.options.logger?.warn(
        {
          deliveryId: delivery.id,
          endpointId: delivery.endpointId,
          organizationId: delivery.organizationId,
          eventName: delivery.eventName,
          attempts: attempt,
          responseStatus: outcome.responseStatus,
          error: outcome.error,
        },
        'webhook delivery gave up',
      );

      return;
    }

    const delayMs = backoffDelay(this.retry, attempt);
    const nextAttemptAt = new Date(this.now().getTime() + delayMs);

    await this.options.deliveries.markResult(delivery.id, {
      status: 'pending',
      attempts: attempt,
      nextAttemptAt,
      responseStatus: outcome.responseStatus,
      responseBody: outcome.responseBody,
      responseTimeMs: outcome.durationMs,
      error: outcome.error,
      completedAt: null,
    });

    // The endpoint's failure counter is not touched here. A delivery that will be retried has not
    // failed yet, and counting each attempt would disable an endpoint after two flaky deliveries
    // rather than after twenty failed ones.
    this.options.metrics?.increment(WEBHOOK_METRICS.RETRY_SCHEDULED, 1, {
      event: delivery.eventName,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);

      // Wakes immediately on stop, so shutdown is not gated on the poll interval.
      this.stopSignal.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
