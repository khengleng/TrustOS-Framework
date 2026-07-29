import type { AuditQuery, AuditQueryResult, AuditRecord, AuditSink } from '../audit-record';

/** In-memory sink for tests. Same contract, no database. */
export class InMemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];

  async append(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }

  async query(query: AuditQuery): Promise<AuditQueryResult> {
    const matches = this.records.filter((record) => {
      if (query.organizationId !== null && record.organizationId !== query.organizationId) {
        return false;
      }
      if (query.actorId && record.actorId !== query.actorId) return false;
      if (query.action && record.action !== query.action) return false;
      if (query.entityType && record.entityType !== query.entityType) return false;
      if (query.entityId && record.entityId !== query.entityId) return false;
      if (query.from && record.occurredAt < query.from) return false;
      if (query.to && record.occurredAt > query.to) return false;
      return true;
    });

    const start = (query.page - 1) * query.pageSize;
    return {
      totalItems: matches.length,
      items: matches.slice(start, start + query.pageSize).map((record, index) => ({
        ...record,
        id: `audit_${index}`,
        createdAt: record.occurredAt,
      })),
    };
  }

  find(action: string): AuditRecord | undefined {
    return this.records.find((record) => record.action === action);
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** A sink that always fails, for testing the non-blocking failure path. */
export class FailingAuditSink implements AuditSink {
  async append(): Promise<void> {
    throw new Error('audit storage unavailable');
  }

  async query(): Promise<AuditQueryResult> {
    throw new Error('audit storage unavailable');
  }
}
