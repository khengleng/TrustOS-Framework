import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import type { JobQueue } from '@trustos/job-runtime';
import {
  MISFIRE_THRESHOLD_MS,
  SCHEDULE_FAILURE_THRESHOLD,
  type MisfirePolicy,
  type Schedule,
  type ScheduleKind,
  type ScheduleRun,
  type ScheduleStatus,
} from './entities';
import { describeCron, isValidTimezone, nextOccurrenceAfterRun, parseCron } from './cron';

export interface ScheduleStore {
  upsert(schedule: Omit<Schedule, 'createdAt' | 'updatedAt'>): Promise<Schedule>;
  findById(id: string, organizationId: string | null): Promise<Schedule | null>;
  findByKey(key: string, organizationId: string | null): Promise<Schedule | null>;

  /**
   * Claims schedules that are due.
   *
   * Must be atomic and must advance `nextRunAt` in the same step. Two scheduler instances is the
   * normal deployment — one per application replica — and both will tick at the same second. A
   * store that reads then writes fires every schedule once per replica, which for a nightly
   * billing run means billing everybody twice.
   */
  claimDue(options: { now: Date; limit: number }): Promise<Schedule[]>;

  update(
    id: string,
    patch: Partial<
      Pick<
        Schedule,
        | 'status'
        | 'nextRunAt'
        | 'lastRunAt'
        | 'lastJobId'
        | 'consecutiveFailures'
        | 'lastError'
        | 'expression'
        | 'timezone'
        | 'intervalMs'
        | 'jobPayload'
        | 'description'
      >
    >,
  ): Promise<Schedule | null>;

  list(filter: {
    organizationId: string | null;
    status?: ScheduleStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Schedule[]; total: number }>;

  delete(id: string, organizationId: string | null): Promise<boolean>;

  recordRun(run: ScheduleRun): Promise<void>;
  listRuns(
    scheduleId: string,
    organizationId: string | null,
    limit?: number,
  ): Promise<ScheduleRun[]>;
}

export interface SchedulerOptions {
  store: ScheduleStore;
  queue: Pick<JobQueue, 'enqueue'>;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  metrics?: MetricsRecorder;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export interface DefineScheduleInput {
  key: string;
  organizationId: string | null;
  description?: string | null;
  kind: ScheduleKind;
  /** For `cron`. */
  expression?: string;
  timezone?: string;
  /** For `interval`. */
  intervalMs?: number;
  /** For `once`. */
  runAt?: Date;
  jobType: string;
  jobPayload?: unknown;
  misfirePolicy?: MisfirePolicy;
  actorId?: string | null;
}

/**
 * The scheduler.
 *
 * Defines schedules, and on each tick enqueues jobs for the ones that are due. Two properties
 * matter more than anything else here:
 *
 *   * **A schedule fires once per due time, across every replica.** `claimDue` is an atomic claim
 *     that advances `nextRunAt` in the same statement. Two replicas ticking at the same second
 *     must not both fire — for a nightly billing run, that is billing everybody twice.
 *   * **The enqueue is idempotent anyway.** Belt and braces: the job's idempotency key is
 *     `schedule:<id>:<scheduled-time>`, so even if a claim somehow fired twice, the queue would
 *     collapse it into one job. Two independent mechanisms, because the consequence of both
 *     failing is duplicated business work.
 */
export class Scheduler {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  private running = false;
  private loop: Promise<void> | null = null;
  private readonly stopSignal = new AbortController();

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Defines or updates a schedule, keyed by `key`.
   *
   * An upsert rather than a create, because schedules are usually declared in code and reconciled
   * at start-up. A create would either fail on the second boot or accumulate a duplicate per
   * deployment.
   */
  async define(input: DefineScheduleInput): Promise<Schedule> {
    const timezone = input.timezone ?? 'UTC';

    if (!isValidTimezone(timezone)) {
      throw ApiError.validation(
        [
          {
            path: 'timezone',
            message: `"${timezone}" is not a timezone this system recognises. Use an IANA name.`,
          },
        ],
        'Unknown timezone.',
      );
    }

    this.assertKindFields(input, timezone);

    const existing = await this.options.store.findByKey(input.key, input.organizationId);
    const now = this.now();

    const nextRunAt = this.computeNextRun(
      {
        kind: input.kind,
        expression: input.expression ?? null,
        timezone,
        intervalMs: input.intervalMs ?? null,
        runAt: input.runAt ?? null,
      },
      null,
      now,
    );

    const schedule = await this.options.store.upsert({
      id: existing?.id ?? this.newId('sched'),
      organizationId: input.organizationId,
      key: input.key,
      description: input.description ?? null,
      kind: input.kind,
      // A redefined schedule keeps its paused state. Redeploying should not silently restart a
      // schedule somebody deliberately paused.
      status: existing?.status ?? 'active',
      expression: input.expression ?? null,
      timezone,
      intervalMs: input.intervalMs ?? null,
      runAt: input.runAt ?? null,
      jobType: input.jobType,
      jobPayload: input.jobPayload ?? {},
      misfirePolicy: input.misfirePolicy ?? 'run_once',
      nextRunAt,
      lastRunAt: existing?.lastRunAt ?? null,
      lastJobId: existing?.lastJobId ?? null,
      consecutiveFailures: 0,
      lastError: null,
      createdById: existing?.createdById ?? input.actorId ?? null,
    });

    await this.options.audit?.record({
      action: existing ? 'schedule.updated' : 'schedule.created',
      entityType: 'Schedule',
      entityId: schedule.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        key: input.key,
        kind: input.kind,
        expression: input.expression ?? null,
        timezone,
        jobType: input.jobType,
        nextRunAt: nextRunAt?.toISOString() ?? null,
      },
    });

    return schedule;
  }

  private assertKindFields(input: DefineScheduleInput, timezone: string): void {
    if (input.kind === 'cron') {
      if (!input.expression) {
        throw ApiError.validation(
          [{ path: 'expression', message: 'A cron schedule needs an expression.' }],
          'This schedule is missing its expression.',
        );
      }
      // Parsed now so a bad expression fails at definition time rather than at the first tick,
      // in a background process, hours later.
      parseCron(input.expression);
      void timezone;
      return;
    }

    if (input.kind === 'interval') {
      if (!input.intervalMs || input.intervalMs < 1000) {
        throw ApiError.validation(
          [
            {
              path: 'intervalMs',
              message:
                'An interval schedule needs an interval of at least 1000ms. Anything shorter is ' +
                'a poll loop, not a schedule.',
            },
          ],
          'This interval is not usable.',
        );
      }
      return;
    }

    if (!input.runAt) {
      throw ApiError.validation(
        [{ path: 'runAt', message: 'A one-time schedule needs a time to run at.' }],
        'This schedule is missing its run time.',
      );
    }
  }

  /** When a schedule should next fire, given when it last did. */
  computeNextRun(
    schedule: Pick<Schedule, 'kind' | 'expression' | 'timezone' | 'intervalMs' | 'runAt'>,
    lastRunAt: Date | null,
    after: Date,
  ): Date | null {
    if (schedule.kind === 'once') {
      // A one-time schedule that has run is finished; returning its time again would re-fire it
      // on every tick forever.
      if (lastRunAt !== null) return null;
      return schedule.runAt;
    }

    if (schedule.kind === 'interval') {
      const base = lastRunAt ?? after;
      const next = new Date(base.getTime() + (schedule.intervalMs ?? 60_000));
      // An interval schedule that fell behind catches up to now rather than firing repeatedly to
      // work through the backlog — which is what "every 5 minutes" means to the person who set it.
      return next.getTime() < after.getTime() ? new Date(after.getTime()) : next;
    }

    if (!schedule.expression) return null;

    return nextOccurrenceAfterRun(
      parseCron(schedule.expression),
      lastRunAt,
      after,
      schedule.timezone,
    );
  }

  start(intervalMs = 10_000): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run(intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopSignal.abort();
    await this.loop;
    this.loop = null;
  }

  private async run(intervalMs: number): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        // The loop survives. A scheduler that stopped on a database blip would silently stop
        // every recurring task in the system.
        this.options.logger?.error(
          { error: error instanceof Error ? error.message : String(error) },
          'scheduler tick failed',
        );
      }

      if (this.running) await this.sleep(intervalMs);
    }
  }

  /** One tick. Exposed so a test, or a cron-driven deployment, can drive it. */
  async tick(limit = 50): Promise<number> {
    const now = this.now();
    const due = await this.options.store.claimDue({ now, limit });

    for (const schedule of due) await this.fire(schedule, now);

    return due.length;
  }

  /** Fires one schedule. Never throws — a bad schedule must not stop the others. */
  private async fire(schedule: Schedule, now: Date): Promise<void> {
    const scheduledFor = schedule.nextRunAt ?? now;
    const latencyMs = now.getTime() - scheduledFor.getTime();

    const record = async (
      outcome: ScheduleRun['outcome'],
      jobId: string | null,
      error: string | null,
    ) => {
      await this.options.store.recordRun({
        id: this.newId('srun'),
        scheduleId: schedule.id,
        organizationId: schedule.organizationId,
        scheduledFor,
        firedAt: now,
        jobId,
        outcome,
        latencyMs,
        error,
      });
    };

    if (schedule.status !== 'active') {
      await record('skipped_paused', null, null);
      return;
    }

    /*
     * A fire that is very late.
     *
     * The process was probably down. `run_once` (the default) runs it now and moves on;
     * `skip` waits for the next scheduled time. `run_all` would work through the backlog and is
     * almost always wrong — six hours of downtime should not produce six nightly reports.
     */
    if (latencyMs > MISFIRE_THRESHOLD_MS && schedule.misfirePolicy === 'skip') {
      this.options.logger?.warn(
        {
          scheduleId: schedule.id,
          key: schedule.key,
          scheduledFor: scheduledFor.toISOString(),
          latencyMs,
        },
        'schedule misfired and was skipped by policy',
      );

      await record('skipped_misfire', null, null);
      await this.advance(schedule, now, null, { clearFailures: true });
      return;
    }

    try {
      const { job, created } = await this.options.queue.enqueue({
        type: schedule.jobType,
        payload: schedule.jobPayload,
        organizationId: schedule.organizationId,
        /*
         * The second line of defence against a double fire.
         *
         * Keyed by the *scheduled* time, not the fire time: two replicas that somehow both
         * claimed this schedule would compute the same key and the queue would collapse them
         * into one job. The claim should already have prevented it; the consequence of both
         * mechanisms failing is duplicated business work, which is worth two mechanisms.
         */
        idempotencyKey: `schedule:${schedule.id}:${scheduledFor.toISOString()}`,
        metadata: {
          scheduleId: schedule.id,
          scheduleKey: schedule.key,
          scheduledFor: scheduledFor.toISOString(),
          latencyMs,
        },
      });

      await record(created ? 'enqueued' : 'deduplicated', job.id, null);
      await this.advance(schedule, now, job.id, { clearFailures: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await record('failed', null, message);

      const consecutiveFailures = schedule.consecutiveFailures + 1;
      const shouldDisable = consecutiveFailures >= SCHEDULE_FAILURE_THRESHOLD;

      await this.options.store.update(schedule.id, {
        consecutiveFailures,
        lastError: message.slice(0, 2000),
        // A schedule that cannot enqueue — usually because its job type is no longer registered
        // — will not fix itself, and firing it every ten seconds fills the log with the same
        // error until somebody notices.
        ...(shouldDisable ? { status: 'disabled' as const, nextRunAt: null } : {}),
      });

      this.options.logger?.error(
        {
          scheduleId: schedule.id,
          key: schedule.key,
          jobType: schedule.jobType,
          consecutiveFailures,
          error: message,
        },
        shouldDisable
          ? 'schedule disabled after repeated failure to enqueue'
          : 'schedule failed to enqueue its job',
      );

      /*
       * Advanced, but the failure counter is left alone.
       *
       * `advance` clears it on a successful fire, and calling it here unconditionally would reset
       * the count this branch has just incremented — so a schedule whose job type no longer
       * exists would sit at one failure forever and never reach the disable threshold.
       */
      if (!shouldDisable) await this.advance(schedule, now, null, { clearFailures: false });
    }
  }

  private async advance(
    schedule: Schedule,
    now: Date,
    jobId: string | null,
    options: { clearFailures: boolean },
  ): Promise<void> {
    const nextRunAt = this.computeNextRun(schedule, now, now);

    await this.options.store.update(schedule.id, {
      lastRunAt: now,
      lastJobId: jobId ?? schedule.lastJobId,
      nextRunAt,
      ...(options.clearFailures ? { consecutiveFailures: 0, lastError: null } : {}),
      // A one-time schedule with nothing left to do disables itself, rather than sitting active
      // with a null next run — which reads as "broken" in every listing.
      ...(nextRunAt === null && schedule.kind === 'once' ? { status: 'disabled' as const } : {}),
    });
  }

  async get(id: string, organizationId: string | null): Promise<Schedule> {
    const schedule = await this.options.store.findById(id, organizationId);
    if (!schedule) throw ApiError.notFound(`No schedule with id "${id}".`);
    return schedule;
  }

  async list(filter: Parameters<ScheduleStore['list']>[0]) {
    return this.options.store.list(filter);
  }

  async runs(id: string, organizationId: string | null, limit = 50): Promise<ScheduleRun[]> {
    await this.get(id, organizationId);
    return this.options.store.listRuns(id, organizationId, limit);
  }

  /**
   * Pauses a schedule.
   *
   * Keeps `nextRunAt`, so resuming does not lose where it was. A paused schedule that had
   * forgotten its next run would fire immediately on resume, which is not what "pause" means.
   */
  async pause(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<Schedule> {
    const schedule = await this.get(id, organizationId);

    if (schedule.status === 'disabled') {
      throw ApiError.conflict('This schedule is disabled and cannot be paused.', {
        reason: 'schedule_disabled',
        scheduleId: id,
      });
    }

    const updated = await this.options.store.update(id, { status: 'paused' });

    await this.options.audit?.record({
      action: 'schedule.paused',
      entityType: 'Schedule',
      entityId: id,
      actorId,
      organizationId,
      before: { status: schedule.status },
      after: { status: 'paused' },
    });

    return updated!;
  }

  /**
   * Resumes a schedule.
   *
   * The next run is recomputed from now rather than restored, so a schedule paused for a month
   * does not fire immediately for a time long past — and does not then fire again at its real
   * next time.
   */
  async resume(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<Schedule> {
    const schedule = await this.get(id, organizationId);
    const now = this.now();

    const updated = await this.options.store.update(id, {
      status: 'active',
      nextRunAt: this.computeNextRun(schedule, schedule.lastRunAt, now),
      consecutiveFailures: 0,
      lastError: null,
    });

    await this.options.audit?.record({
      action: 'schedule.resumed',
      entityType: 'Schedule',
      entityId: id,
      actorId,
      organizationId,
      before: { status: schedule.status },
      after: { status: 'active', nextRunAt: updated?.nextRunAt?.toISOString() ?? null },
    });

    return updated!;
  }

  async disable(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<Schedule> {
    const schedule = await this.get(id, organizationId);
    const updated = await this.options.store.update(id, { status: 'disabled', nextRunAt: null });

    await this.options.audit?.record({
      action: 'schedule.disabled',
      entityType: 'Schedule',
      entityId: id,
      actorId,
      organizationId,
      before: { status: schedule.status },
      after: { status: 'disabled' },
    });

    return updated!;
  }

  /**
   * Fires a schedule now, out of band.
   *
   * For "run it now" in an admin UI. It does **not** advance `nextRunAt` — a manual run is extra,
   * not a replacement, and an operator testing a nightly job at 3pm should not thereby cancel
   * tonight's run.
   */
  async runNow(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<{ jobId: string }> {
    const schedule = await this.get(id, organizationId);
    const now = this.now();

    const { job } = await this.options.queue.enqueue({
      type: schedule.jobType,
      payload: schedule.jobPayload,
      organizationId: schedule.organizationId,
      // A distinct key, so a manual run is never collapsed into the scheduled one — and two
      // clicks of "run now" in the same second are.
      idempotencyKey: `schedule:${schedule.id}:manual:${now.toISOString()}`,
      metadata: {
        scheduleId: schedule.id,
        scheduleKey: schedule.key,
        manual: true,
        triggeredBy: actorId,
      },
      actorId,
    });

    await this.options.store.recordRun({
      id: this.newId('srun'),
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      scheduledFor: now,
      firedAt: now,
      jobId: job.id,
      outcome: 'enqueued',
      latencyMs: 0,
      error: null,
    });

    await this.options.audit?.record({
      action: 'schedule.run_now',
      entityType: 'Schedule',
      entityId: id,
      actorId,
      organizationId,
      after: { jobId: job.id },
    });

    return { jobId: job.id };
  }

  async delete(id: string, organizationId: string | null, actorId: string | null): Promise<void> {
    await this.get(id, organizationId);
    await this.options.store.delete(id, organizationId);

    await this.options.audit?.record({
      action: 'schedule.deleted',
      entityType: 'Schedule',
      entityId: id,
      actorId,
      organizationId,
    });
  }

  /** Renders a schedule in words. For the admin UI and `trustos doctor integrations`. */
  describe(schedule: Schedule): string {
    if (schedule.kind === 'cron' && schedule.expression) {
      return describeCron(parseCron(schedule.expression), schedule.timezone);
    }

    if (schedule.kind === 'interval') {
      const seconds = Math.round((schedule.intervalMs ?? 0) / 1000);
      return seconds >= 60
        ? `every ${Math.round(seconds / 60)} minutes`
        : `every ${seconds} seconds`;
    }

    return `once, at ${schedule.runAt?.toISOString() ?? 'an unset time'}`;
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
}
