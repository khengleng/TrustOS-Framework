import type {
  ExceptionKind,
  ExceptionStatus,
  ReconciliationException,
  ReconciliationRun,
  ReconciliationStore,
} from './reconciliation';

/** In-memory reconciliation stores, for tests and development. */
export class InMemoryReconciliationStore implements ReconciliationStore {
  readonly runs = new Map<string, ReconciliationRun>();
  readonly exceptionsById = new Map<string, ReconciliationException>();

  async createRun(run: ReconciliationRun): Promise<ReconciliationRun> {
    this.runs.set(run.id, run);
    return run;
  }

  async findRun(id: string, organizationId: string | null): Promise<ReconciliationRun | null> {
    const run = this.runs.get(id);
    if (!run || run.organizationId !== organizationId) return null;
    return run;
  }

  async updateRun(
    id: string,
    patch: Partial<ReconciliationRun>,
  ): Promise<ReconciliationRun | null> {
    const run = this.runs.get(id);
    if (!run) return null;

    const updated = { ...run, ...patch } as ReconciliationRun;
    this.runs.set(id, updated);
    return updated;
  }

  async listRuns(input: {
    organizationId: string | null;
    key?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ReconciliationRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.organizationId === input.organizationId)
      .filter((run) => !input.key || run.key === input.key)
      .filter((run) => !input.from || run.windowEnd >= input.from)
      .filter((run) => !input.to || run.windowStart <= input.to)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, input.limit ?? 100);
  }

  async addExceptions(exceptions: ReconciliationException[]): Promise<void> {
    for (const exception of exceptions) this.exceptionsById.set(exception.id, exception);
  }

  async findException(
    id: string,
    organizationId: string | null,
  ): Promise<ReconciliationException | null> {
    const exception = this.exceptionsById.get(id);
    if (!exception || exception.organizationId !== organizationId) return null;
    return exception;
  }

  async updateException(
    id: string,
    patch: Partial<ReconciliationException>,
  ): Promise<ReconciliationException | null> {
    const exception = this.exceptionsById.get(id);
    if (!exception) return null;

    const updated = { ...exception, ...patch } as ReconciliationException;
    this.exceptionsById.set(id, updated);
    return updated;
  }

  async exceptions(input: {
    organizationId: string | null;
    runId?: string;
    status?: ExceptionStatus;
    kind?: ExceptionKind;
    limit?: number;
  }): Promise<ReconciliationException[]> {
    return [...this.exceptionsById.values()]
      .filter((exception) => exception.organizationId === input.organizationId)
      .filter((exception) => !input.runId || exception.runId === input.runId)
      .filter((exception) => !input.status || exception.status === input.status)
      .filter((exception) => !input.kind || exception.kind === input.kind)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, input.limit ?? 500);
  }
}
