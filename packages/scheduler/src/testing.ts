import type { Schedule, ScheduleRun, ScheduleStatus } from './entities';
import type { ScheduleStore } from './scheduler';

/**
 * An in-memory schedule store.
 *
 * For tests and development. `claimDue` documents the one thing a real implementation must not
 * get wrong.
 */
export class InMemoryScheduleStore implements ScheduleStore {
  readonly schedules = new Map<string, Schedule>();
  readonly runs: ScheduleRun[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async upsert(input: Omit<Schedule, 'createdAt' | 'updatedAt'>): Promise<Schedule> {
    const existing = this.schedules.get(input.id);
    const now = this.now();

    const schedule: Schedule = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async findById(id: string, organizationId: string | null): Promise<Schedule | null> {
    const schedule = this.schedules.get(id);
    if (!schedule || schedule.organizationId !== organizationId) return null;
    return schedule;
  }

  async findByKey(key: string, organizationId: string | null): Promise<Schedule | null> {
    return (
      [...this.schedules.values()].find(
        (schedule) => schedule.key === key && schedule.organizationId === organizationId,
      ) ?? null
    );
  }

  /**
   * Claims due schedules.
   *
   * The claim and the `nextRunAt` advance happen together. In SQL that MUST be one statement:
   * `UPDATE schedule SET next_run_at = NULL WHERE id IN (SELECT id FROM schedule WHERE status =
   * 'active' AND next_run_at <= $1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT $2)
   * RETURNING *`.
   *
   * Two scheduler instances is the normal deployment — one per application replica — and both
   * tick at the same second. A store that reads then writes fires every schedule once per
   * replica, which for a nightly billing run means billing everybody twice.
   */
  async claimDue(options: { now: Date; limit: number }): Promise<Schedule[]> {
    const due = [...this.schedules.values()]
      .filter(
        (schedule) =>
          schedule.status === 'active' &&
          schedule.nextRunAt !== null &&
          schedule.nextRunAt <= options.now,
      )
      .sort((a, b) => (a.nextRunAt?.getTime() ?? 0) - (b.nextRunAt?.getTime() ?? 0))
      .slice(0, options.limit);

    // Cleared as part of the claim, so a second tick before the fire completes finds nothing.
    // The scheduler recomputes it in `advance`.
    for (const schedule of due) {
      this.schedules.set(schedule.id, { ...schedule, nextRunAt: null });
    }

    return due;
  }

  async update(id: string, patch: Partial<Schedule>): Promise<Schedule | null> {
    const schedule = this.schedules.get(id);
    if (!schedule) return null;

    const updated = { ...schedule, ...patch, updatedAt: this.now() };
    this.schedules.set(id, updated);
    return updated;
  }

  async list(filter: {
    organizationId: string | null;
    status?: ScheduleStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Schedule[]; total: number }> {
    const all = [...this.schedules.values()]
      .filter((schedule) => schedule.organizationId === filter.organizationId)
      .filter((schedule) => !filter.status || schedule.status === filter.status)
      .sort((a, b) => a.key.localeCompare(b.key));

    const offset = filter.offset ?? 0;
    return { items: all.slice(offset, offset + (filter.limit ?? 50)), total: all.length };
  }

  async delete(id: string, organizationId: string | null): Promise<boolean> {
    const schedule = await this.findById(id, organizationId);
    if (!schedule) return false;
    this.schedules.delete(id);
    return true;
  }

  async recordRun(run: ScheduleRun): Promise<void> {
    this.runs.push(run);
  }

  async listRuns(
    scheduleId: string,
    organizationId: string | null,
    limit = 50,
  ): Promise<ScheduleRun[]> {
    return this.runs
      .filter((run) => run.scheduleId === scheduleId && run.organizationId === organizationId)
      .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())
      .slice(0, limit);
  }
}
