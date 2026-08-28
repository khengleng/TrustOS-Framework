import type { TaskListQuery, TaskPage, TaskStore } from './service';
import type { DatabaseRow, GroupedCount, WorkflowTaskRecord } from '@trustos/workflow-core';

/**
 * Prisma-backed task store.
 *
 * Written against a narrow delegate rather than a `PrismaClient`, for the reason phase 2
 * found: the framework's client and a generated application's client come from different
 * schemas and are not structurally assignable, so naming the capability keeps this usable
 * with either.
 *
 * The important method is `claim`, and the important word in it is `updateMany`.
 * `update` on a primary key throws when no row matches; `updateMany` returns a count. The
 * count is what makes the claim safe: two callers race, one gets `count: 1` and one gets
 * `count: 0`, and zero is the signal that somebody else won. There is no window between a
 * check and a write, because there is no check — the condition is in the `where`.
 */
export interface TaskDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<TaskRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
    skip?: number;
    take?: number;
  }): Promise<TaskRow[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<TaskRow>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

/**
 * A row as the database has it.
 *
 * `status` and `priority` are plain strings because that is what a Prisma client returns
 * for an enum stored as text. `narrow` re-establishes the unions on the way out, and a
 * value outside them means somebody wrote to the table by hand — which is worth a loud
 * failure rather than a silent cast.
 */
export type TaskRow = DatabaseRow<WorkflowTaskRecord>;

const STATUSES = new Set([
  'open',
  'assigned',
  'claimed',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
  'expired',
]);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

function narrow(row: TaskRow): WorkflowTaskRecord;
function narrow(row: TaskRow | null): WorkflowTaskRecord | null;
function narrow(row: TaskRow | null): WorkflowTaskRecord | null {
  if (!row) return null;
  if (!STATUSES.has(row.status)) {
    throw new Error(`Task ${row.id} has status "${row.status}", which is not a known status.`);
  }
  if (!PRIORITIES.has(row.priority)) {
    throw new Error(
      `Task ${row.id} has priority "${row.priority}", which is not a known priority.`,
    );
  }
  return row as WorkflowTaskRecord;
}

export class PrismaTaskStore implements TaskStore {
  constructor(
    private readonly delegate: TaskDelegate,
    /**
     * A grouped count, injected.
     *
     * Optional, so a deployment that does not need the per-assignee load figure does not
     * have to wire it. Absent, `countOpenByAssignee` returns nothing — which is honest: it
     * is used for a dashboard tile and for a least-loaded resolver, and both should show
     * nothing rather than a wrong number.
     */
    private readonly groupBy?: GroupedCount,
  ) {}

  async findById(id: string, organizationId: string): Promise<WorkflowTaskRecord | null> {
    // Filtered by organization, which is what the cross-tenant test relies on.
    return narrow(await this.delegate.findFirst({ where: { id, organizationId } }));
  }

  async list(query: TaskListQuery): Promise<TaskPage> {
    const where = this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where,
        // Priority then due date: the most urgent thing that is closest to its deadline
        // is what a person should pick up next, and a queue ordered by creation time is
        // a queue where the oldest low-priority item blocks the view.
        orderBy: [{ priority: 'desc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.delegate.count({ where }),
    ]);

    return {
      items: rows.map((row) => narrow(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(
    input: Omit<WorkflowTaskRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowTaskRecord> {
    return narrow(await this.delegate.create({ data: { ...input } }));
  }

  /**
   * The atomic claim.
   *
   * `claimedById: null` is in the `where` as well as the version. Both, because they
   * guard different things: the version catches any concurrent change, and the explicit
   * null makes the intent legible to whoever reads this next — a claim only applies to an
   * unclaimed task, and that should not be something a reader has to infer from a version
   * number.
   */
  async claim(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    claimedById: string;
    claimedAt: Date;
  }): Promise<WorkflowTaskRecord | null> {
    const result = await this.delegate.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        version: input.expectedVersion,
        claimedById: null,
        status: { in: ['open', 'assigned'] },
      },
      data: {
        claimedById: input.claimedById,
        claimedAt: input.claimedAt,
        status: 'claimed',
        version: { increment: 1 },
      },
    });

    // Zero rows means somebody else won the race. Returning null rather than throwing
    // lets the service decide what to tell the caller.
    if (result.count === 0) return null;

    return this.findById(input.id, input.organizationId);
  }

  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<WorkflowTaskRecord>;
  }): Promise<WorkflowTaskRecord | null> {
    const result = await this.delegate.updateMany({
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

  async cancelForInstance(input: {
    workflowInstanceId: string;
    organizationId: string;
    at: Date;
    reason: string;
  }): Promise<number> {
    // No version condition: this cancels whatever is open, and a concurrent claim on a
    // task the workflow has already left is a claim that should lose anyway.
    const result = await this.delegate.updateMany({
      where: {
        workflowInstanceId: input.workflowInstanceId,
        organizationId: input.organizationId,
        status: { in: ['open', 'assigned', 'claimed', 'in_progress'] },
      },
      data: {
        status: 'cancelled',
        outcome: input.reason,
        completedAt: input.at,
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  async listOverdue(input: {
    organizationId?: string;
    asOf: Date;
    limit: number;
  }): Promise<WorkflowTaskRecord[]> {
    const rows = await this.delegate.findMany({
      where: {
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        status: { in: ['open', 'assigned', 'claimed', 'in_progress'] },
        dueAt: { lte: input.asOf, not: null },
      },
      orderBy: { dueAt: 'asc' },
      take: input.limit,
    });
    return rows.map((row) => narrow(row));
  }

  async countOpenByAssignee(
    organizationId: string,
  ): Promise<Array<{ userId: string; count: number }>> {
    if (!this.groupBy) return [];

    const groups = await this.groupBy({
      by: ['assigneeUserId'],
      where: {
        organizationId,
        status: { in: ['open', 'assigned', 'claimed', 'in_progress'] },
        assigneeUserId: { not: null },
      },
    });

    return groups
      .map((group) => ({
        userId: group.assigneeUserId as string | null,
        count: (group._count as { _all: number } | undefined)?._all ?? 0,
      }))
      .filter((entry): entry is { userId: string; count: number } => Boolean(entry.userId));
  }

  /**
   * Builds the `where` for a task list.
   *
   * The eligibility case is the interesting one. "Tasks I could claim" is *assigned to
   * me, or pooled to a role I hold, or pooled to a group I am in* — expressed as an `OR`
   * so the database evaluates it, rather than reading every open task in the organization
   * and filtering in memory. An organization with 50,000 open tasks makes that difference
   * the whole query.
   */
  private buildWhere(query: TaskListQuery): Record<string, unknown> {
    const where: Record<string, unknown> = { organizationId: query.organizationId };

    if (query.status) where.status = { in: query.status };
    if (query.workflowInstanceId) where.workflowInstanceId = query.workflowInstanceId;
    if (query.priority) where.priority = { in: query.priority };
    if (query.dueBefore) where.dueAt = { lte: query.dueBefore, not: null };

    if (query.assigneeUserId) {
      // Assigned *or* claimed by them. A task somebody claimed out of a pool is theirs
      // and must appear in their list even though `assigneeUserId` may still be null.
      where.OR = [{ assigneeUserId: query.assigneeUserId }, { claimedById: query.assigneeUserId }];
    } else if (query.eligibleFor) {
      const { roles, groupIds, userId } = query.eligibleFor;
      where.OR = [
        { assigneeUserId: userId },
        ...(roles.length > 0 ? [{ assigneeRole: { in: roles }, claimedById: null }] : []),
        ...(groupIds.length > 0 ? [{ assigneeGroupId: { in: groupIds }, claimedById: null }] : []),
      ];
    }

    return where;
  }
}
