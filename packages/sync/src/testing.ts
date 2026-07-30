import type { SyncConflict, SyncConnection, SyncRun, SyncStore } from './sync';

/** An in-memory sync store, for tests and development. */
export class InMemorySyncStore implements SyncStore {
  readonly connections = new Map<string, SyncConnection>();
  readonly runs = new Map<string, SyncRun>();
  readonly conflicts: SyncConflict[] = [];

  async createConnection(connection: SyncConnection): Promise<SyncConnection> {
    this.connections.set(connection.id, connection);
    return connection;
  }

  async findConnection(id: string, organizationId: string | null): Promise<SyncConnection | null> {
    const connection = this.connections.get(id);
    if (!connection || connection.organizationId !== organizationId) return null;
    return connection;
  }

  async updateConnection(id: string, patch: Partial<SyncConnection>): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.set(id, { ...connection, ...patch, updatedAt: new Date() });
  }

  async listConnections(organizationId: string | null): Promise<SyncConnection[]> {
    return [...this.connections.values()]
      .filter((connection) => connection.organizationId === organizationId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createRun(run: SyncRun): Promise<SyncRun> {
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(id: string, patch: Partial<SyncRun>): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.set(id, { ...run, ...patch });
  }

  async listRuns(
    connectionId: string,
    organizationId: string | null,
    limit = 50,
  ): Promise<SyncRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.connectionId === connectionId && run.organizationId === organizationId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  async recordConflict(conflict: SyncConflict): Promise<void> {
    this.conflicts.push(conflict);
  }

  async listConflicts(filter: {
    organizationId: string | null;
    connectionId?: string;
    unresolvedOnly?: boolean;
    limit?: number;
  }): Promise<SyncConflict[]> {
    return this.conflicts
      .filter((conflict) => conflict.organizationId === filter.organizationId)
      .filter((conflict) => !filter.connectionId || conflict.connectionId === filter.connectionId)
      .filter((conflict) => !filter.unresolvedOnly || conflict.resolvedAt === null)
      .slice(0, filter.limit ?? 100);
  }

  async resolveConflict(
    id: string,
    organizationId: string | null,
    resolvedById: string,
  ): Promise<void> {
    const index = this.conflicts.findIndex(
      (conflict) => conflict.id === id && conflict.organizationId === organizationId,
    );
    if (index === -1) return;

    this.conflicts[index] = {
      ...this.conflicts[index]!,
      resolvedAt: new Date(),
      resolvedById,
    };
  }
}
