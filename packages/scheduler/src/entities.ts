import { z } from 'zod';

/**
 * Schedules.
 *
 * A schedule does not do work. It enqueues a job at the right time, and the job runtime does the
 * rest — retry, cancellation, progress, history, crash recovery. That indirection is the single
 * most useful decision in this package: a scheduled task that ran its own code inline would need
 * every one of those things reimplemented, and would lose all of them on a restart.
 */

export const SCHEDULE_KINDS = [
  /** A cron expression, in a named timezone. */
  'cron',
  /** Every N milliseconds from the last run. Simpler than cron when the interval is the point. */
  'interval',
  /** Runs once, at a fixed time, then disables itself. */
  'once',
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const SCHEDULE_STATUSES = [
  'active',
  /** Paused by an operator. Keeps its next-run time; resuming does not lose the schedule. */
  'paused',
  /** Finished (a `once` schedule) or retired. Terminal. */
  'disabled',
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/**
 * What to do when a fire was missed — because the process was down, or the scheduler was behind.
 *
 * The default is `skip`, and that default is the important part. A nightly report whose process
 * was down for six hours should run once when it comes back, not produce six reports. `runOnce`
 * is that behaviour; `skip` waits for the next scheduled time; `runAll` is available and is
 * almost always wrong.
 */
export const MISFIRE_POLICIES = ['run_once', 'skip', 'run_all'] as const;
export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number];

export const scheduleSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),

  /** Unique per organization. Stable across restarts — it is how a definition is reconciled. */
  key: z.string().min(1).max(120),
  description: z.string().max(500).nullable(),

  kind: z.enum(SCHEDULE_KINDS),
  status: z.enum(SCHEDULE_STATUSES),

  /** For `cron`. */
  expression: z.string().max(200).nullable(),
  /**
   * IANA timezone.
   *
   * Not optional in practice: "run at 2am" means nothing without one, and defaulting to UTC
   * silently means "run at 9am" for a team in Phnom Penh. Defaults to UTC only because a default
   * is needed, and the CLI and admin UI both prompt for it.
   */
  timezone: z.string().max(64),

  /** For `interval`, in milliseconds. */
  intervalMs: z.number().int().min(1000).nullable(),

  /** For `once`. */
  runAt: z.date().nullable(),

  /** The job to enqueue. */
  jobType: z.string().min(1).max(120),
  jobPayload: z.unknown(),

  misfirePolicy: z.enum(MISFIRE_POLICIES),

  /**
   * When it should next fire. Computed on save and after every run.
   *
   * Stored rather than derived, so the tick is an indexed query for due rows instead of parsing
   * every schedule's expression on every tick. With a thousand schedules and a ten-second tick
   * that is the difference between a rounding error and a measurable load.
   */
  nextRunAt: z.date().nullable(),

  lastRunAt: z.date().nullable(),
  lastJobId: z.string().nullable(),

  /**
   * Consecutive failures to *enqueue*.
   *
   * Not job failures — the job's own history covers those. This counts the schedule failing to
   * do its one task, which is a different and more alarming problem.
   */
  consecutiveFailures: z.number().int().min(0),
  lastError: z.string().max(2000).nullable(),

  createdAt: z.date(),
  updatedAt: z.date(),
  createdById: z.string().nullable(),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export const scheduleRunSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  organizationId: z.string().nullable(),
  /** When it was meant to fire. Differs from `firedAt` when the scheduler was behind. */
  scheduledFor: z.date(),
  firedAt: z.date(),
  /** Null when the enqueue itself failed. */
  jobId: z.string().nullable(),
  outcome: z.enum(['enqueued', 'skipped_misfire', 'skipped_paused', 'failed', 'deduplicated']),
  /** Lateness in milliseconds. The number that says whether the scheduler is keeping up. */
  latencyMs: z.number().int(),
  error: z.string().max(2000).nullable(),
});

export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

/**
 * How late a fire may be before it counts as a misfire.
 *
 * Five minutes. Below that it is the scheduler being slightly behind — a busy tick, a slow
 * database — and running the job is right. Above it, the process was probably down, and the
 * misfire policy applies.
 */
export const MISFIRE_THRESHOLD_MS = 5 * 60 * 1000;

/** Consecutive enqueue failures before a schedule is disabled. */
export const SCHEDULE_FAILURE_THRESHOLD = 10;
