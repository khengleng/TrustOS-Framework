import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';
import type { AuditService } from '@trustsystem/audit';
import type { LoggerPort } from '@trustsystem/logging';
import { DEFAULT_LEASE_MS, isTerminal, type Job, type JobRun, type JobStatus } from './entities';
import type { JobRegistry } from './registry';

/**
 * The queue: enqueueing, querying and cancelling. The worker is in `worker.ts`.
 *
 * Split that way so an HTTP route can enqueue a job without importing a poll loop, and so the
 * worker can run in a separate process against the same store — which is how a deployment scales
 * job capacity without scaling its web tier.
 */

export interface JobStore {
  /**
   * Inserts a job.
   *
   * Returns the existing job when `idempotencyKey` collides with a non-terminal one, rather than
   * inserting a second. That MUST be a unique constraint rather than a prior read: "rebuild this
   * report" clicked twice in the same second is precisely when a check-then-insert loses.
   *
   * The constraint is partial — only over non-terminal jobs — so the same key can be used again
   * once the first has finished. Otherwise a nightly job keyed by its date could never re-run
   * after a failure.
   */
  insert(job: Omit<Job, 'createdAt'>): Promise<{ job: Job; created: boolean }>;

  findById(id: string, organizationId: string | null): Promise<Job | null>;

  /**
   * Claims the next runnable jobs.
   *
   * Must be atomic. In SQL: `UPDATE ... WHERE (status = 'queued' AND run_at <= now()) OR
   * (status = 'running' AND lease_expires_at < now()) ORDER BY priority, run_at
   * FOR UPDATE SKIP LOCKED`. Two workers polling together must never receive the same row.
   *
   * The `lease_expires_at` half is how a crashed worker's jobs are recovered — without it they
   * stay `running` forever and nothing touches them again.
   */
  claim(options: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMs: number;
    /** Only these types. For a worker dedicated to one kind of work. */
    types?: string[];
  }): Promise<Job[]>;

  /** Extends the lease, and reports whether this worker still holds it. */
  renewLease(id: string, workerId: string, leaseExpiresAt: Date): Promise<boolean>;

  update(
    id: string,
    patch: Partial<
      Pick<
        Job,
        | 'status'
        | 'attempts'
        | 'runAt'
        | 'startedAt'
        | 'completedAt'
        | 'claimedBy'
        | 'leaseExpiresAt'
        | 'progress'
        | 'progressMessage'
        | 'result'
        | 'error'
      >
    >,
  ): Promise<void>;

  /**
   * Moves a job to a status only if it is currently in one of `from`.
   *
   * Returns whether it applied. The conditional is what makes cancellation safe: cancelling a job
   * that has just started must not overwrite `running` with `cancelled` and orphan the handler.
   */
  transition(
    id: string,
    from: JobStatus[],
    patch: Partial<Job> & { status: JobStatus },
  ): Promise<boolean>;

  recordRun(run: JobRun): Promise<void>;
  listRuns(jobId: string, organizationId: string | null): Promise<JobRun[]>;

  list(filter: {
    organizationId: string | null;
    status?: JobStatus;
    type?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Job[]; total: number }>;

  countByStatus(organizationId: string | null): Promise<Record<JobStatus, number>>;

  /** Retention. A busy queue produces millions of rows a year. */
  purgeTerminalOlderThan(cutoff: Date): Promise<number>;
}

export interface EnqueueInput<TPayload = unknown> {
  type: string;
  payload: TPayload;
  organizationId: string | null;
  /** Overrides the handler's default. */
  priority?: number;
  maxAttempts?: number;
  /** Runs no earlier than this. How delay is expressed — there is no separate `delayMs`. */
  runAt?: Date;
  idempotencyKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
  actorId?: string | null;
}

export interface EnqueueResult {
  job: Job;
  /** False when an existing job was returned for the same idempotency key. */
  created: boolean;
}

export interface JobQueueOptions {
  store: JobStore;
  registry: JobRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class JobQueue {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: JobQueueOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Enqueues a job.
   *
   * The payload is validated here, synchronously, against the handler's schema. The caller who
   * built a bad payload gets the error in their own stack trace — rather than a worker failing
   * minutes later in a different process, attached to nothing they can see.
   */
  async enqueue<TPayload>(input: EnqueueInput<TPayload>): Promise<EnqueueResult> {
    const handler = this.options.registry.get(input.type);
    const payload = this.options.registry.validate(input.type, input.payload);

    const now = this.now();
    const runAt = input.runAt ?? now;

    if (runAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) {
      // A job scheduled two years out is nearly always a unit mistake — seconds passed where
      // milliseconds were expected, or the other way round.
      throw ApiError.validation(
        [
          {
            path: 'runAt',
            message:
              `A job cannot be scheduled more than ${MAX_SCHEDULE_AHEAD_MS / 86_400_000} days ` +
              'ahead. For a genuinely long delay, use a schedule rather than a queued job.',
          },
        ],
        'This job is scheduled too far ahead.',
      );
    }

    const { job, created } = await this.options.store.insert({
      id: this.newId('job'),
      organizationId: input.organizationId,
      type: input.type,
      payload,
      status: 'queued',
      priority: input.priority ?? handler.priority,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? handler.maxAttempts,
      runAt,
      startedAt: null,
      completedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
      progress: 0,
      progressMessage: null,
      result: null,
      error: null,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
      createdById: input.actorId ?? null,
    });

    if (!created) {
      // Not an error. The caller asked for this work to happen once, and it is already going to.
      this.options.logger?.debug(
        { jobId: job.id, type: input.type, idempotencyKey: input.idempotencyKey },
        'job already queued under this idempotency key',
      );
    }

    return { job, created };
  }

  async get(id: string, organizationId: string | null): Promise<Job> {
    const job = await this.options.store.findById(id, organizationId);
    if (!job) throw ApiError.notFound(`No job with id "${id}".`);
    return job;
  }

  async list(filter: Parameters<JobStore['list']>[0]): Promise<{ items: Job[]; total: number }> {
    return this.options.store.list(filter);
  }

  async runs(jobId: string, organizationId: string | null): Promise<JobRun[]> {
    await this.get(jobId, organizationId);
    return this.options.store.listRuns(jobId, organizationId);
  }

  /**
   * Cancels a job.
   *
   * A queued job is cancelled outright. A *running* job is marked cancelled and its handler's
   * abort signal fires — but the handler decides whether to stop. A handler that ignores its
   * signal keeps running, and the job's recorded outcome will say `cancelled` while the work
   * continues. That is stated here because the alternative — pretending cancellation is
   * guaranteed — is worse than documenting that it is cooperative.
   */
  async cancel(
    id: string,
    organizationId: string | null,
    options: { actorId: string | null; reason?: string },
  ): Promise<Job> {
    const job = await this.get(id, organizationId);

    if (isTerminal(job.status)) {
      throw ApiError.conflict(`This job is already ${job.status} and cannot be cancelled.`, {
        reason: 'job_terminal',
        jobId: id,
        status: job.status,
      });
    }

    const applied = await this.options.store.transition(id, ['queued', 'running'], {
      status: 'cancelled',
      completedAt: this.now(),
      error: options.reason ?? 'Cancelled.',
    });

    if (!applied) {
      // It finished between the read and the write. A losing race here is normal, not an error
      // worth an exception — but the caller should see the real state.
      return this.get(id, organizationId);
    }

    await this.options.audit?.record({
      action: 'job.cancelled',
      entityType: 'Job',
      entityId: id,
      actorId: options.actorId,
      organizationId,
      before: { status: job.status },
      after: { status: 'cancelled', reason: options.reason ?? null },
    });

    return this.get(id, organizationId);
  }

  /**
   * Re-queues a failed job.
   *
   * A new attempt on the same row rather than a new job, so the run history stays in one place —
   * "this job failed twice and then succeeded" is one record rather than three.
   */
  async retry(
    id: string,
    organizationId: string | null,
    options: { actorId: string | null; additionalAttempts?: number },
  ): Promise<Job> {
    const job = await this.get(id, organizationId);

    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw ApiError.conflict(
        `Only a failed or cancelled job can be retried; this one is ${job.status}.`,
        { reason: 'job_not_retryable', jobId: id, status: job.status },
      );
    }

    const applied = await this.options.store.transition(id, ['failed', 'cancelled'], {
      status: 'queued',
      runAt: this.now(),
      // The attempt budget is topped up. Without this, retrying a job that failed because it
      // exhausted its attempts would put it straight back into the same state.
      maxAttempts: job.attempts + (options.additionalAttempts ?? 1),
      claimedBy: null,
      leaseExpiresAt: null,
      completedAt: null,
      error: null,
    });

    if (!applied) return this.get(id, organizationId);

    await this.options.audit?.record({
      action: 'job.retried',
      entityType: 'Job',
      entityId: id,
      actorId: options.actorId,
      organizationId,
      before: { status: job.status, attempts: job.attempts },
      after: { status: 'queued' },
    });

    return this.get(id, organizationId);
  }

  /** Queue depth by status. For the health endpoint and the dashboard. */
  async stats(organizationId: string | null): Promise<Record<JobStatus, number>> {
    return this.options.store.countByStatus(organizationId);
  }

  /** The lease duration a worker should use. Here so the queue and worker cannot disagree. */
  get leaseMs(): number {
    return DEFAULT_LEASE_MS;
  }
}

/** The furthest ahead a job may be scheduled. Beyond this, use a schedule. */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
