import type {
  CaseRecord,
  CaseStatus,
  DatabaseRow,
  GroupedCount,
  WorkflowInstanceRecord,
} from '@trustos/workflow-core';
import type { CaseListQuery, CaseStore } from './service';

/**
 * Prisma-backed case store.
 *
 * A narrow delegate rather than a `PrismaClient`, for the reason phase 2 found: the
 * framework's client and a generated application's are not structurally assignable.
 *
 * `reference` generation is not here. It belongs to the application, because "CASE-1042"
 * versus "CMP-2026-0043" is a business decision and a framework guess would be wrong
 * everywhere. `CaseService` takes a `reference` callback; without one it falls back to a
 * timestamp-based value that is unique but not pretty.
 */
/** A case row. Every narrowed union is text in the database. */
export type CaseRow = DatabaseRow<CaseRecord>;

function narrowCase(row: CaseRow): CaseRecord;
function narrowCase(row: CaseRow | null): CaseRecord | null;
function narrowCase(row: CaseRow | null): CaseRecord | null {
  return row ? (row as CaseRecord) : null;
}

export interface CaseDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CaseRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
    skip?: number;
    take?: number;
  }): Promise<CaseRow[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<CaseRow>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

export interface InstanceLookupDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<Array<DatabaseRow<WorkflowInstanceRecord>>>;
}

export class PrismaCaseStore implements CaseStore {
  constructor(
    private readonly cases: CaseDelegate,
    private readonly instances: InstanceLookupDelegate,
    /** Optional. Absent, `countByStatus` returns nothing rather than a wrong number. */
    private readonly groupBy?: GroupedCount,
  ) {}

  async findById(id: string, organizationId: string): Promise<CaseRecord | null> {
    return narrowCase(await this.cases.findFirst({ where: { id, organizationId } }));
  }

  async findByReference(reference: string, organizationId: string): Promise<CaseRecord | null> {
    return narrowCase(await this.cases.findFirst({ where: { reference, organizationId } }));
  }

  async create(
    input: Omit<CaseRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<CaseRecord> {
    return narrowCase(await this.cases.create({ data: { ...input } }));
  }

  /** Conditional on the version the reader saw. Null on a conflict. */
  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<CaseRecord>;
  }): Promise<CaseRecord | null> {
    const result = await this.cases.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        version: input.expectedVersion,
      },
      data: { ...input.patch, version: { increment: 1 } },
    });

    if (result.count === 0) return null;
    return this.findById(input.id, input.organizationId);
  }

  async list(query: CaseListQuery) {
    const where: Record<string, unknown> = { organizationId: query.organizationId };

    if (query.status) where.status = { in: query.status };
    if (query.caseType) where.caseType = { in: query.caseType };
    if (query.ownerId) where.ownerId = query.ownerId;
    if (query.assignedTeam) where.assignedTeam = query.assignedTeam;
    if (query.priority) where.priority = { in: query.priority };
    if (query.businessObjectType) where.businessObjectType = query.businessObjectType;
    if (query.businessObjectId) where.businessObjectId = query.businessObjectId;
    if (query.dueBefore) where.dueAt = { lte: query.dueBefore, not: null };

    const [rows, total] = await Promise.all([
      this.cases.findMany({
        where,
        // Priority, then the deadline, then age. The most urgent case closest to its
        // deadline is what somebody should pick up; ordering by age alone means the
        // oldest low-priority case sits at the top of the queue forever.
        orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.cases.count({ where }),
    ]);

    return {
      items: rows.map((row) => narrowCase(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async listInstances(caseId: string, organizationId: string): Promise<WorkflowInstanceRecord[]> {
    const rows = await this.instances.findMany({
      where: { caseId, organizationId },
      orderBy: { startedAt: 'asc' },
    });
    return rows as WorkflowInstanceRecord[];
  }

  async countByStatus(
    organizationId: string,
  ): Promise<Array<{ status: CaseStatus; count: number }>> {
    if (!this.groupBy) return [];

    // A grouped count rather than paging: producing "18 open, 4 escalated" by reading every
    // case is the query that makes a dashboard slow as soon as a tenant has real volume.
    const groups = await this.groupBy({ by: ['status'], where: { organizationId } });

    return groups.map((group) => ({
      status: group.status as CaseStatus,
      count: (group._count as { _all: number } | undefined)?._all ?? 0,
    }));
  }
}
