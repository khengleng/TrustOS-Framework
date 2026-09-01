import { randomUUID } from 'node:crypto';
import type { LoggerPort } from '@trustsystem/logging';
import type { MetricsRecorder } from '@trustsystem/observability';
import { backoffDelay, RETRY_PRESETS, type RetryPolicy } from '@trustsystem/retry';
import { DEFAULT_LEASE_MS, LEASE_RENEWAL_MS, type Job } from './entities';
import { JOB_METRICS } from './metrics';
import type { JobStore } from './queue';
import type { JobRegistry } from './registry';

/**
 * The job worker.
 *
 * Claims jobs, runs their handlers, records what happened. The part that is easy to get wrong is
 * not the loop — it is the lease.
 *
 * **The lease is what keeps a job from running twice.** A worker claims a job with an expiry and
 * renews it while the handler runs. If the process dies, the lease expires and another worker
 * picks the job up. If the handler is merely slow, renewal keeps the claim alive.
 *
 * The failure that follows from getting it wrong: a renewal that fails — because another worker
 * has already reclaimed the job — means *this* worker is no longer the owner. It must stop, and
 * it must not write a result. Two workers both writing an outcome for one job produces a record
 * that says a job succeeded once and failed once, and no way to tell which is true. So a lost
 * lease aborts the handler and the outcome is discarded.
 */

export interface JobWorkerOptions {
  store: JobStore;
  registry: JobRegistry;

  /** Only these types. For a worker dedicated to one kind of work. */
  types?: string[];
  /** How many jobs run at once across all types. */
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  /** Backoff between attempts. Defaults to the background preset. */
  retry?: RetryPolicy;

  logger?: LoggerPort;
  metrics?: MetricsRecorder;
  now?: () => Date;
  newId?: (prefix: string) => string;
  workerId?: string;
}

export class JobWorker {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly leaseMs: number;
  private readonly retry: RetryPolicy;

  readonly workerId: string;

  private running = false;
  private loop: Promise<void> | null = null;
  private readonly stopSignal = new AbortController();
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly options: JobWorkerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.retry = options.retry ?? RETRY_PRESETS.background;
    this.workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /**
   * Stops, signalling handlers and waiting for them.
   *
   * The signal goes out first so a cooperative handler can wind down, then the wait. A handler
   * that ignores its signal is waited on until the caller gives up — which is the honest
   * behaviour, since the alternative is exiting while it still holds a lease and a database
   * connection.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal.abort();

    for (const controller of this.inFlight.values()) controller.abort();

    await this.loop;
    this.loop = null;
  }

  private async run(): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 1000;

    while (this.running) {
      let claimed = 0;

      try {
        claimed = await this.tick();
      } catch (error) {
        // The loop survives a store failure. A queue that stops draining because the database
        // blipped is a queue that silently stops working.
        this.options.logger?.error(
          {
            workerId: this.workerId,
            error: error instanceof Error ? error.message : String(error),
          },
          'job worker tick failed',
        );
      }

      if (claimed === 0 && this.running) await this.sleep(pollIntervalMs);
    }
  }

  /** One poll. Exposed so a test, or a cron-driven deployment, can drive the worker directly. */
  async tick(): Promise<number> {
    const concurrency = this.options.concurrency ?? 5;
    const available = concurrency - this.inFlight.size;
    if (available <= 0) return 0;

    const jobs = await this.options.store.claim({
      workerId: this.workerId,
      now: this.now(),
      limit: available,
      leaseMs: this.leaseMs,
      types: this.options.types,
    });

    if (jobs.length === 0) return 0;

    await Promise.all(jobs.map((job) => this.process(job)));
    return jobs.length;
  }

  /** Runs one job. Never throws — the loop above depends on it. */
  private async process(job: Job): Promise<void> {
    const attempt = job.attempts + 1;
    const startedAt = this.now();

    const controller = new AbortController();
    this.inFlight.set(job.id, controller);

    const onStop = () => controller.abort();
    this.stopSignal.signal.addEventListener('abort', onStop, { once: true });

    // Renewal runs alongside the handler. Losing the lease aborts it — see the class header.
    const renewal = this.startLeaseRenewal(job, controller);

    let outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'lease_lost' = 'failed';
    let error: string | null = null;
    let result: unknown = null;

    try {
      const handler = this.options.registry.get(job.type);

      await this.options.store.update(job.id, {
        status: 'running',
        attempts: attempt,
        startedAt,
        progress: 0,
      });

      result = await this.runWithTimeout(handler, job, attempt, controller);
      outcome = 'succeeded';
    } catch (caught) {
      if (renewal.leaseLost) {
        outcome = 'lease_lost';
        error = 'The lease was lost — another worker has taken this job.';
      } else if (isAbort(caught)) {
        outcome = this.running ? 'cancelled' : 'cancelled';
        error = 'The job was cancelled.';
      } else if (isTimeout(caught)) {
        outcome = 'timed_out';
        error = caught instanceof Error ? caught.message : 'Timed out.';
      } else {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    } finally {
      renewal.stop();
      this.stopSignal.signal.removeEventListener('abort', onStop);
      this.inFlight.delete(job.id);
    }

    /*
     * A lost lease writes nothing.
     *
     * Another worker owns this job now. Writing an outcome would produce a record saying it both
     * succeeded and failed, with no way to tell which run it describes.
     */
    if (outcome === 'lease_lost') {
      this.options.logger?.warn(
        { jobId: job.id, workerId: this.workerId, type: job.type },
        'job lease lost mid-run; discarding this run',
      );
      this.options.metrics?.increment(JOB_METRICS.LEASE_LOST, 1, { type: job.type });
      return;
    }

    await this.recordOutcome(job, attempt, startedAt, outcome, error, result);
  }

  private async runWithTimeout(
    handler: ReturnType<JobRegistry['get']>,
    job: Job,
    attempt: number,
    controller: AbortController,
  ): Promise<unknown> {
    const run = handler.handle({
      jobId: job.id,
      organizationId: job.organizationId,
      payload: job.payload,
      attempt,
      signal: controller.signal,
      metadata: job.metadata,
      reportProgress: async (percent, message) => {
        // Best-effort: a job must not fail because a progress write did.
        try {
          await this.options.store.update(job.id, {
            progress: Math.max(0, Math.min(100, Math.round(percent))),
            progressMessage: message?.slice(0, 500) ?? null,
          });
        } catch {
          /* deliberately ignored — progress is diagnostic */
        }
      },
    });

    if (handler.timeoutMs === null) return run;

    // The timeout aborts the handler's signal as well as losing the race. A race alone would
    // leave the handler running, still holding its database connection, invisible.
    const timer = setTimeout(() => controller.abort(), handler.timeoutMs);

    try {
      return await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => {
              const timeout = new Error(
                `Job "${job.type}" exceeded its ${handler.timeoutMs}ms timeout.`,
              );
              timeout.name = 'JobTimeoutError';
              reject(timeout);
            },
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recordOutcome(
    job: Job,
    attempt: number,
    startedAt: Date,
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
    error: string | null,
    result: unknown,
  ): Promise<void> {
    const finishedAt = this.now();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await this.options.store.recordRun({
      id: this.newId('jrun'),
      jobId: job.id,
      organizationId: job.organizationId,
      attempt,
      workerId: this.workerId,
      startedAt,
      finishedAt,
      durationMs,
      outcome,
      error: error?.slice(0, 4000) ?? null,
    });

    this.options.metrics?.observe(JOB_METRICS.DURATION_MS, durationMs, {
      type: job.type,
      outcome,
    });

    if (outcome === 'succeeded') {
      await this.options.store.update(job.id, {
        status: 'succeeded',
        completedAt: finishedAt,
        progress: 100,
        result,
        error: null,
        claimedBy: null,
        leaseExpiresAt: null,
      });

      this.options.metrics?.increment(JOB_METRICS.SUCCEEDED, 1, { type: job.type });
      return;
    }

    if (outcome === 'cancelled') {
      // `transition` rather than `update`: the job may already have been marked cancelled by the
      // caller who requested it, and this must not overwrite that record's reason.
      await this.options.store.transition(job.id, ['running'], {
        status: 'cancelled',
        completedAt: finishedAt,
        error,
        claimedBy: null,
        leaseExpiresAt: null,
      });

      this.options.metrics?.increment(JOB_METRICS.CANCELLED, 1, { type: job.type });
      return;
    }

    const canRetry = attempt < job.maxAttempts;

    if (canRetry) {
      const delayMs = backoffDelay(this.retry, attempt);

      await this.options.store.update(job.id, {
        // Back to `queued`, not a `retrying` state — a job waiting for its next attempt is
        // queued, and a second state would mean every "what is waiting" query knows about two.
        status: 'queued',
        runAt: new Date(finishedAt.getTime() + delayMs),
        error,
        claimedBy: null,
        leaseExpiresAt: null,
      });

      this.options.metrics?.increment(JOB_METRICS.RETRIED, 1, { type: job.type });

      this.options.logger?.warn(
        { jobId: job.id, type: job.type, attempt, maxAttempts: job.maxAttempts, error },
        'job attempt failed; will retry',
      );
      return;
    }

    await this.options.store.update(job.id, {
      status: 'failed',
      completedAt: finishedAt,
      error,
      claimedBy: null,
      leaseExpiresAt: null,
    });

    this.options.metrics?.increment(JOB_METRICS.FAILED, 1, { type: job.type });

    this.options.logger?.error(
      {
        jobId: job.id,
        type: job.type,
        organizationId: job.organizationId,
        attempts: attempt,
        error,
      },
      'job failed permanently',
    );
  }

  /**
   * Renews the lease while a handler runs.
   *
   * A failed renewal means another worker has claimed the job — this one is no longer the owner.
   * The handler is aborted and `leaseLost` is set, which stops the outcome being written.
   */
  private startLeaseRenewal(
    job: Job,
    controller: AbortController,
  ): { stop: () => void; leaseLost: boolean } {
    const state = { leaseLost: false };

    const timer = setInterval(() => {
      void (async () => {
        try {
          const held = await this.options.store.renewLease(
            job.id,
            this.workerId,
            new Date(this.now().getTime() + this.leaseMs),
          );

          if (!held) {
            state.leaseLost = true;
            controller.abort();
          }
        } catch {
          /*
           * A renewal that errored is not proof the lease is lost.
           *
           * Treating a transient database error as lease loss would abandon a healthy job. The
           * lease will expire on its own if the problem persists, and another worker will take
           * it then — which is the outcome that error was pointing at anyway.
           */
        }
      })();
    }, LEASE_RENEWAL_MS);

    // The interval must not hold the event loop open on its own.
    timer.unref?.();

    return {
      stop: () => clearInterval(timer),
      get leaseLost() {
        return state.leaseLost;
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);

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

  /** How many jobs this worker is running. For the health endpoint. */
  get activeCount(): number {
    return this.inFlight.size;
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  );
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'JobTimeoutError'
  );
}
