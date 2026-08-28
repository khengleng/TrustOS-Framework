import { isTerminal, type Job, type JobRun, type JobStatus } from './entities';
import type { JobStore } from './queue';

/**
 * An in-memory job store.
 *
 * For tests and development. It also documents what a real implementation owes: the two methods
 * with capitalised comments — `insert` and `claim` — are where an implementation that looks
 * correct is wrong.
 */
export class InMemoryJobStore implements JobStore {
  readonly jobs = new Map<string, Job>();
  readonly runs: JobRun[] = [];

  /**
   * The idempotency index.
   *
   * Only non-terminal jobs are in it, which is what lets a key be reused once its job has
   * finished — otherwise a nightly job keyed by its date could never re-run after a failure.
   *
   * In SQL this is a partial unique index:
   * `CREATE UNIQUE INDEX ... ON job (organization_id, idempotency_key)
   *  WHERE status IN ('queued', 'running')`.
   */
  private readonly activeKeys = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private keyFor(job: Pick<Job, 'organizationId' | 'idempotencyKey'>): string | null {
    if (!job.idempotencyKey) return null;
    // Scoped by organization: two tenants using the same key are two different jobs, and sharing
    // the namespace would let one tenant suppress another's work.
    return `${job.organizationId ?? 'platform'}|${job.idempotencyKey}`;
  }

  async insert(input: Omit<Job, 'createdAt'>): Promise<{ job: Job; created: boolean }> {
    const key = this.keyFor(input);

    if (key) {
      const existingId = this.activeKeys.get(key);
      const existing = existingId ? this.jobs.get(existingId) : undefined;

      // MUST be a constraint violation in SQL, not a prior read. "Rebuild this report" clicked
      // twice in one second is exactly when a check-then-insert loses the race.
      if (existing && !isTerminal(existing.status)) {
        return { job: existing, created: false };
      }
    }

    const job: Job = { ...input, createdAt: this.now() };
    this.jobs.set(job.id, job);
    if (key) this.activeKeys.set(key, job.id);

    return { job, created: true };
  }

  async findById(id: string, organizationId: string | null): Promise<Job | null> {
    const job = this.jobs.get(id);
    if (!job || job.organizationId !== organizationId) return null;
    return job;
  }

  /**
   * Claims runnable jobs.
   *
   * The claim and the status change happen together. In SQL that MUST be one statement with
   * `FOR UPDATE SKIP LOCKED` or an `UPDATE ... RETURNING` — two workers polling together must
   * never receive the same row.
   *
   * Both halves of the `WHERE` matter: queued-and-due, *or* running-with-an-expired-lease. The
   * second is how a crashed worker's jobs come back.
   */
  async claim(options: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMs: number;
    types?: string[];
  }): Promise<Job[]> {
    const runnable = [...this.jobs.values()]
      .filter((job) => !options.types || options.types.includes(job.type))
      .filter((job) => {
        if (job.status === 'queued') return job.runAt <= options.now;
        if (job.status === 'running') {
          return job.leaseExpiresAt !== null && job.leaseExpiresAt < options.now;
        }
        return false;
      })
      // Lower priority number first, then oldest first. Deterministic, so a starved job
      // eventually runs rather than losing to a steady stream of equals.
      .sort((a, b) => a.priority - b.priority || a.runAt.getTime() - b.runAt.getTime())
      .slice(0, options.limit);

    const leaseExpiresAt = new Date(options.now.getTime() + options.leaseMs);

    return runnable.map((job) => {
      const claimed: Job = {
        ...job,
        status: 'running',
        claimedBy: options.workerId,
        leaseExpiresAt,
      };
      this.jobs.set(job.id, claimed);
      return claimed;
    });
  }

  async renewLease(id: string, workerId: string, leaseExpiresAt: Date): Promise<boolean> {
    const job = this.jobs.get(id);

    // The worker id is part of the condition. A renewal by a worker that no longer owns the job
    // must fail — that is how the owner learns it has been superseded.
    if (!job || job.claimedBy !== workerId || job.status !== 'running') return false;

    this.jobs.set(id, { ...job, leaseExpiresAt });
    return true;
  }

  async update(id: string, patch: Partial<Job>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;

    const updated = { ...job, ...patch };
    this.jobs.set(id, updated);

    // A job reaching a terminal state releases its idempotency key, so the same key can be used
    // for the next run of the same logical work.
    const key = this.keyFor(updated);
    if (key && isTerminal(updated.status)) this.activeKeys.delete(key);
  }

  async transition(
    id: string,
    from: JobStatus[],
    patch: Partial<Job> & { status: JobStatus },
  ): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || !from.includes(job.status)) return false;

    await this.update(id, patch);
    return true;
  }

  async recordRun(run: JobRun): Promise<void> {
    this.runs.push(run);
  }

  async listRuns(jobId: string, organizationId: string | null): Promise<JobRun[]> {
    return this.runs
      .filter((run) => run.jobId === jobId && run.organizationId === organizationId)
      .sort((a, b) => a.attempt - b.attempt);
  }

  async list(filter: {
    organizationId: string | null;
    status?: JobStatus;
    type?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Job[]; total: number }> {
    const all = [...this.jobs.values()]
      .filter((job) => job.organizationId === filter.organizationId)
      .filter((job) => !filter.status || job.status === filter.status)
      .filter((job) => !filter.type || job.type === filter.type)
      .filter((job) => !filter.from || job.createdAt >= filter.from)
      .filter((job) => !filter.to || job.createdAt <= filter.to)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = filter.offset ?? 0;
    return { items: all.slice(offset, offset + (filter.limit ?? 50)), total: all.length };
  }

  async countByStatus(organizationId: string | null): Promise<Record<JobStatus, number>> {
    const counts: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const job of this.jobs.values()) {
      if (job.organizationId !== organizationId) continue;
      counts[job.status] += 1;
    }

    return counts;
  }

  async purgeTerminalOlderThan(cutoff: Date): Promise<number> {
    let removed = 0;

    for (const [id, job] of this.jobs) {
      if (isTerminal(job.status) && job.createdAt < cutoff) {
        this.jobs.delete(id);
        removed += 1;
      }
    }

    return removed;
  }
}
