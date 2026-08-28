import type { ImportRun, ImportStatus, ImportStore } from './import-service';

/** An in-memory import store, for tests and development. */
export class InMemoryImportStore implements ImportStore {
  readonly runs = new Map<string, ImportRun>();

  async create(run: ImportRun): Promise<ImportRun> {
    this.runs.set(run.id, run);
    return run;
  }

  async findById(id: string, organizationId: string | null): Promise<ImportRun | null> {
    const run = this.runs.get(id);
    if (!run || run.organizationId !== organizationId) return null;
    return run;
  }

  async update(id: string, patch: Partial<ImportRun>): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.set(id, { ...run, ...patch });
  }

  async list(filter: {
    organizationId: string | null;
    type?: string;
    status?: ImportStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ImportRun[]; total: number }> {
    const all = [...this.runs.values()]
      .filter((run) => run.organizationId === filter.organizationId)
      .filter((run) => !filter.type || run.type === filter.type)
      .filter((run) => !filter.status || run.status === filter.status)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const offset = filter.offset ?? 0;
    return { items: all.slice(offset, offset + (filter.limit ?? 50)), total: all.length };
  }
}
