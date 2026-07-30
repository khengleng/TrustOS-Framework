import type { FeeSchedule, FeeScheduleStore } from './schedule';

/** An in-memory fee schedule store, for tests and development. */
export class InMemoryFeeScheduleStore implements FeeScheduleStore {
  readonly schedules = new Map<string, FeeSchedule>();

  async create(schedule: FeeSchedule): Promise<FeeSchedule> {
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async find(id: string, organizationId: string | null): Promise<FeeSchedule | null> {
    const schedule = this.schedules.get(id);
    if (!schedule || schedule.organizationId !== organizationId) return null;
    return schedule;
  }

  async findEffective(input: {
    key: string;
    organizationId: string | null;
    at: Date;
  }): Promise<FeeSchedule | null> {
    return (
      [...this.schedules.values()]
        .filter((schedule) => schedule.organizationId === input.organizationId)
        .filter((schedule) => schedule.key === input.key)
        .filter((schedule) => schedule.status === 'published')
        .filter((schedule) => schedule.effectiveFrom <= input.at)
        // `effectiveTo` is exclusive: the moment a new version starts, the old one has stopped.
        .filter((schedule) => schedule.effectiveTo === null || schedule.effectiveTo > input.at)
        .sort((a, b) => b.version - a.version)[0] ?? null
    );
  }

  async listVersions(key: string, organizationId: string | null): Promise<FeeSchedule[]> {
    return [...this.schedules.values()]
      .filter((schedule) => schedule.organizationId === organizationId && schedule.key === key)
      .sort((a, b) => a.version - b.version);
  }

  async update(id: string, patch: Partial<FeeSchedule>): Promise<FeeSchedule | null> {
    const schedule = this.schedules.get(id);
    if (!schedule) return null;

    const updated = { ...schedule, ...patch };
    this.schedules.set(id, updated);
    return updated;
  }
}
