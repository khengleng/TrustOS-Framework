import { z } from 'zod';

/**
 * Background jobs.
 *
 * A job is work that happens outside a request: an export to build, a batch to reconcile, an
 * import to process. The queue is the database, for the same reason the webhook queue is — one
 * durable store that is already backed up beats a second one that is not.
 *
 * The state machine is small and every transition is a row update, so "what is this job doing"
 * is a query rather than an inference:
 *
 *     queued ──claim──▶ running ──┬──▶ succeeded
 *        │                        ├──▶ failed ──retry──▶ queued
 *        │                        └──▶ failed (terminal, retries exhausted)
 *        └──cancel──▶ cancelled          ▲
 *                                        └── running ──cancel──▶ cancelled
 *
 * `running → queued` on retry rather than a separate `retrying` state: a job waiting for its next
 * attempt is queued, and inventing a state for it would mean every query that asks "what is
 * waiting" has to know about two.
 */

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Terminal states. A job here is never claimed again. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/**
 * Priority.
 *
 * Lower runs first, so `0` is the most urgent — the same convention as `nice`, and the opposite
 * of what people usually guess. The names exist so nobody has to guess.
 */
export const JOB_PRIORITY = {
  /** A user is waiting. An export they just clicked. */
  interactive: 0,
  normal: 50,
  /** A nightly reconciliation. Nobody is watching. */
  bulk: 100,
} as const;

export const jobSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),

  /**
   * Which handler runs it.
   *
   * Registered at start-up. A job whose type has no registered handler cannot run, and the
   * runtime says so loudly rather than leaving it queued forever — a silently stuck queue is
   * discovered days later by somebody asking where their export went.
   */
  type: z.string().min(1).max(120),

  /** Handler input. Validated against the handler's schema before the job is even enqueued. */
  payload: z.unknown(),

  status: z.enum(JOB_STATUSES),
  priority: z.number().int().min(0).max(1000),

  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),

  /**
   * When it becomes eligible to run.
   *
   * Also how delay is implemented: a job scheduled for later is simply queued with a future
   * `runAt`. One mechanism rather than two, and no in-memory timer that a restart would lose.
   */
  runAt: z.date(),

  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),

  /**
   * Which worker holds it, and until when.
   *
   * The lease is what makes a crashed worker recoverable: a running job whose lease has expired
   * is reclaimed. Without it, a job held by a process that no longer exists stays `running`
   * forever and nothing else will touch it.
   */
  claimedBy: z.string().nullable(),
  leaseExpiresAt: z.date().nullable(),

  /** 0 to 100. Written by the handler for a long job, so a UI can show something honest. */
  progress: z.number().int().min(0).max(100),
  progressMessage: z.string().max(500).nullable(),

  /** The handler's result, for a job whose output is small enough to keep inline. */
  result: z.unknown(),
  error: z.string().max(4000).nullable(),

  /**
   * Deduplication key.
   *
   * Unique among non-terminal jobs when set. "Rebuild this report" clicked twice should produce
   * one job, and the constraint is what makes that true rather than a check that races.
   */
  idempotencyKey: z.string().max(200).nullable(),

  /** Correlation id, actor, request id — enough to tie the job back to what caused it. */
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),

  createdAt: z.date(),
  createdById: z.string().nullable(),
});

export type Job = z.infer<typeof jobSchema>;

export const jobRunSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  organizationId: z.string().nullable(),
  attempt: z.number().int().min(1),
  workerId: z.string(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  outcome: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'lease_lost']),
  error: z.string().max(4000).nullable(),
});

export type JobRun = z.infer<typeof jobRunSchema>;

/**
 * How long a claim is held before another worker may take it.
 *
 * Two minutes, extended by the runtime while a handler is running. The trade-off is direct: too
 * short and a slow-but-healthy job gets stolen and runs twice; too long and a crashed worker's
 * job sits idle. Extending a live lease is what lets the default be short enough to recover
 * quickly without punishing slow work.
 */
export const DEFAULT_LEASE_MS = 2 * 60 * 1000;

/** How often a running handler renews its lease. Comfortably inside the lease. */
export const LEASE_RENEWAL_MS = 30 * 1000;
