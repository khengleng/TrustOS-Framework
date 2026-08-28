import type { ExportRun, ExportStatus, ExportStore } from './export-service';

/** An in-memory export store, for tests and development. */
export class InMemoryExportStore implements ExportStore {
  readonly runs = new Map<string, ExportRun>();

  async create(run: ExportRun): Promise<ExportRun> {
    this.runs.set(run.id, run);
    return run;
  }

  async findById(id: string, organizationId: string | null): Promise<ExportRun | null> {
    const run = this.runs.get(id);
    if (!run || run.organizationId !== organizationId) return null;
    return run;
  }

  async update(id: string, patch: Partial<ExportRun>): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.set(id, { ...run, ...patch });
  }

  async list(filter: {
    organizationId: string | null;
    type?: string;
    status?: ExportStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ExportRun[]; total: number }> {
    const all = [...this.runs.values()]
      .filter((run) => run.organizationId === filter.organizationId)
      .filter((run) => !filter.type || run.type === filter.type)
      .filter((run) => !filter.status || run.status === filter.status)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const offset = filter.offset ?? 0;
    return { items: all.slice(offset, offset + (filter.limit ?? 50)), total: all.length };
  }
}
