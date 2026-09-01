import { WORKFLOW_EVENT_TYPES } from '@trustsystem/workflow-core';
import type {
  CommentVisibility,
  WorkflowAttachmentRecord,
  WorkflowCommentAmendmentRecord,
  WorkflowCommentRecord,
  WorkflowEventRecord,
} from '@trustsystem/workflow-core';
import type { AttachmentStore, CommentStore } from './collaboration';
import type { HistoryPage, HistoryQuery, HistoryStore } from './history';

/**
 * Prisma-backed history, comments and attachments.
 *
 * Narrow delegates rather than a `PrismaClient`, for the reason phase 2 found: the
 * framework's client and a generated application's are not structurally assignable.
 *
 * Two methods here need a transaction and say so in their signature. `append` allocates a
 * sequence number, and `amend` writes two rows that must both land or neither. Everything
 * else is a single statement.
 */

export interface Transactional {
  /** Runs a callback inside a transaction. Prisma's `$transaction` satisfies this. */
  transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}

/**
 * A history row as the database has it.
 *
 * `type`, `actorType`, `metadata` and `risk`-shaped columns are loose here because that is
 * what a Prisma client returns for text and Json columns. Naming the narrowed union in the
 * port would make the port unusable with the very client it exists to accept — the same
 * lesson as `ServiceAccountRow` in phase 4, learned again by a compiler error.
 *
 * `narrowEvent` re-establishes the unions on the way out.
 */
export interface EventRow extends Omit<WorkflowEventRecord, 'type' | 'actorType' | 'metadata'> {
  type: string;
  actorType: string | null;
  metadata: unknown;
}

export interface EventDelegate {
  create(args: { data: Record<string, unknown> }): Promise<EventRow>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    skip?: number;
    take?: number;
  }): Promise<EventRow[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  aggregate(args: {
    where: Record<string, unknown>;
    _max: { sequence: true };
  }): Promise<{ _max: { sequence: number | null } }>;
}

/**
 * Narrows a row to the record type.
 *
 * An unrecognised event type means somebody wrote to the table by hand. History is
 * append-only at the database, so that write would itself have been refused — but a cast
 * that silently accepted anything would make the type annotation decorative.
 */
function narrowEvent(row: EventRow): WorkflowEventRecord {
  if (!(WORKFLOW_EVENT_TYPES as readonly string[]).includes(row.type)) {
    throw new Error(
      `Workflow event ${row.id} has type "${row.type}", which is not a known event type.`,
    );
  }

  return {
    ...row,
    type: row.type as WorkflowEventRecord['type'],
    actorType: row.actorType as WorkflowEventRecord['actorType'],
    metadata: (row.metadata ?? null) as WorkflowEventRecord['metadata'],
  };
}

export class PrismaHistoryStore implements HistoryStore {
  constructor(private readonly delegate: EventDelegate) {}

  /**
   * Appends an event, allocating its sequence number.
   *
   * The sequence is `max + 1` for the instance, and the unique index on
   * `(workflowInstanceId, sequence)` is what makes that safe: two concurrent appends may
   * both compute the same number, and one of them then violates the constraint. The retry
   * recomputes and succeeds.
   *
   * A `SELECT max()` followed by an `INSERT` without that constraint would silently
   * produce two events with the same sequence, and a history that cannot be ordered is
   * not a history. The retry loop is bounded — three attempts is more than enough for a
   * collision that requires two writers in the same millisecond, and looping forever
   * under contention would be worse than failing.
   */
  async append(input: Omit<WorkflowEventRecord, 'id' | 'sequence'>): Promise<WorkflowEventRecord> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = input.workflowInstanceId
        ? ((
            await this.delegate.aggregate({
              where: { workflowInstanceId: input.workflowInstanceId },
              _max: { sequence: true },
            })
          )._max.sequence ?? 0) + 1
        : // A case-only or definition-only event has no instance to sequence against.
          // The unique index is on `(workflowInstanceId, sequence)`, and Postgres treats
          // nulls as distinct, so any value is acceptable here — 0 makes it obvious in
          // the data that no instance sequence applies.
          0;

      try {
        return narrowEvent(await this.delegate.create({ data: { ...input, sequence: next } }));
      } catch (error) {
        lastError = error;
        if (!isUniqueViolation(error)) throw error;
      }
    }

    throw lastError;
  }

  async query(query: HistoryQuery): Promise<HistoryPage> {
    const where = this.buildWhere(query);

    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where,
        // Newest first for a page of history, which is what a reader opens to.
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.delegate.count({ where }),
    ]);

    return {
      items: rows.map(narrowEvent),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async recent(input: {
    organizationId: string;
    workflowInstanceId: string;
    limit: number;
  }): Promise<WorkflowEventRecord[]> {
    // By sequence, not by timestamp: two events in one transaction share a millisecond,
    // and the point of the sequence is that it does not.
    const rows = await this.delegate.findMany({
      where: {
        organizationId: input.organizationId,
        workflowInstanceId: input.workflowInstanceId,
      },
      orderBy: { sequence: 'desc' },
      take: input.limit,
    });

    return rows.map(narrowEvent);
  }

  count(input: { organizationId: string; workflowInstanceId: string }): Promise<number> {
    return this.delegate.count({ where: input });
  }

  private buildWhere(query: HistoryQuery): Record<string, unknown> {
    return {
      organizationId: query.organizationId,
      ...(query.workflowInstanceId ? { workflowInstanceId: query.workflowInstanceId } : {}),
      ...(query.caseId ? { caseId: query.caseId } : {}),
      ...(query.workflowTaskId ? { workflowTaskId: query.workflowTaskId } : {}),
      ...(query.types ? { type: { in: query.types } } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };
  }
}

/** Prisma's unique-constraint error code. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

// --- comments --------------------------------------------------------------

/** A comment row. `visibility` and `authorActorType` are text columns. */
export interface CommentRow extends Omit<WorkflowCommentRecord, 'visibility' | 'authorActorType'> {
  visibility: string;
  authorActorType: string;
}

export interface CommentDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CommentRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    skip?: number;
    take?: number;
  }): Promise<CommentRow[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<CommentRow>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<CommentRow>;
}

function narrowComment(row: CommentRow): WorkflowCommentRecord;
function narrowComment(row: CommentRow | null): WorkflowCommentRecord | null;
function narrowComment(row: CommentRow | null): WorkflowCommentRecord | null {
  if (!row) return null;
  return row as WorkflowCommentRecord;
}

export interface AmendmentDelegate {
  create(args: { data: Record<string, unknown> }): Promise<WorkflowCommentAmendmentRecord>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<WorkflowCommentAmendmentRecord[]>;
}

export class PrismaCommentStore implements CommentStore {
  constructor(
    private readonly comments: CommentDelegate,
    private readonly amendments: AmendmentDelegate,
    /**
     * A transaction runner.
     *
     * Required, not optional. `amend` writes the amendment row and updates the comment,
     * and either half alone is worse than neither: an amendment with no update leaves
     * history claiming an edit that did not happen, and an update with no amendment is
     * exactly the silent edit the whole mechanism exists to prevent.
     */
    private readonly tx: Transactional,
  ) {}

  async findById(id: string, organizationId: string): Promise<WorkflowCommentRecord | null> {
    return narrowComment(await this.comments.findFirst({ where: { id, organizationId } }));
  }

  async create(
    input: Omit<WorkflowCommentRecord, 'id' | 'createdAt' | 'updatedAt' | 'amendmentCount'>,
  ): Promise<WorkflowCommentRecord> {
    return narrowComment(await this.comments.create({ data: { ...input } }));
  }

  async amend(input: {
    id: string;
    organizationId: string;
    newMessage: string;
    amendedById: string;
    reason: string | null;
    at: Date;
  }): Promise<{ comment: WorkflowCommentRecord; amendment: WorkflowCommentAmendmentRecord }> {
    return this.tx.transaction(async () => {
      const existing = await this.comments.findFirst({
        where: { id: input.id, organizationId: input.organizationId },
      });
      if (!existing) throw new Error(`Comment ${input.id} not found.`);

      const amendment = await this.amendments.create({
        data: {
          workflowCommentId: input.id,
          organizationId: input.organizationId,
          previousMessage: existing.message,
          amendedById: input.amendedById,
          reason: input.reason,
          amendedAt: input.at,
        },
      });

      const comment = await this.comments.update({
        where: { id: input.id },
        data: {
          message: input.newMessage,
          amendmentCount: { increment: 1 },
        },
      });

      return { comment: narrowComment(comment), amendment };
    });
  }

  async redact(input: {
    id: string;
    organizationId: string;
    redactedById: string;
    at: Date;
  }): Promise<WorkflowCommentRecord> {
    // The message is untouched. The usual reason to redact is that a comment contains
    // something it should not, which is exactly when the original must remain available
    // to whoever is investigating.
    return narrowComment(
      await this.comments.update({
        where: { id: input.id },
        data: { redactedAt: input.at, redactedById: input.redactedById },
      }),
    );
  }

  async list(input: {
    organizationId: string;
    workflowInstanceId?: string;
    caseId?: string;
    visibilities: CommentVisibility[];
    page: number;
    pageSize: number;
  }): Promise<{ items: WorkflowCommentRecord[]; total: number }> {
    const where = {
      organizationId: input.organizationId,
      ...(input.workflowInstanceId ? { workflowInstanceId: input.workflowInstanceId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      // The visibility filter is in the query, so the database returns only what the
      // reader may see. Filtering afterwards would mean the narrower levels were read out
      // and then discarded, which is one refactor away from being returned.
      visibility: { in: input.visibilities },
    };

    const [rows, total] = await Promise.all([
      this.comments.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.comments.count({ where }),
    ]);

    return { items: rows.map((row) => narrowComment(row)), total };
  }

  listAmendments(
    commentId: string,
    organizationId: string,
  ): Promise<WorkflowCommentAmendmentRecord[]> {
    return this.amendments.findMany({
      where: { workflowCommentId: commentId, organizationId },
      orderBy: { amendedAt: 'asc' },
    });
  }
}

// --- attachments -----------------------------------------------------------

/** An attachment row. `classification` and `scanStatus` are text columns. */
export interface AttachmentRow extends Omit<
  WorkflowAttachmentRecord,
  'classification' | 'scanStatus'
> {
  classification: string;
  scanStatus: string;
}

export interface AttachmentDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<AttachmentRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<AttachmentRow[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<AttachmentRow>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<AttachmentRow>;
}

function narrowAttachment(row: AttachmentRow): WorkflowAttachmentRecord;
function narrowAttachment(row: AttachmentRow | null): WorkflowAttachmentRecord | null;
function narrowAttachment(row: AttachmentRow | null): WorkflowAttachmentRecord | null {
  if (!row) return null;
  return row as WorkflowAttachmentRecord;
}

export class PrismaAttachmentStore implements AttachmentStore {
  constructor(private readonly delegate: AttachmentDelegate) {}

  async findById(id: string, organizationId: string): Promise<WorkflowAttachmentRecord | null> {
    return narrowAttachment(await this.delegate.findFirst({ where: { id, organizationId } }));
  }

  async create(input: Omit<WorkflowAttachmentRecord, 'id'>): Promise<WorkflowAttachmentRecord> {
    return narrowAttachment(await this.delegate.create({ data: { ...input } }));
  }

  async markRemoved(input: {
    id: string;
    organizationId: string;
    removedById: string;
    at: Date;
  }): Promise<WorkflowAttachmentRecord> {
    return narrowAttachment(
      await this.delegate.update({
        where: { id: input.id },
        data: { removedAt: input.at, removedById: input.removedById },
      }),
    );
  }

  async list(input: {
    organizationId: string;
    workflowInstanceId?: string;
    caseId?: string;
    stepKey?: string;
    includeRemoved?: boolean;
  }): Promise<WorkflowAttachmentRecord[]> {
    const rows = await this.delegate.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.workflowInstanceId ? { workflowInstanceId: input.workflowInstanceId } : {}),
        ...(input.caseId ? { caseId: input.caseId } : {}),
        ...(input.stepKey ? { stepKey: input.stepKey } : {}),
        ...(input.includeRemoved ? {} : { removedAt: null }),
      },
      orderBy: { attachedAt: 'asc' },
    });

    return rows.map((row) => narrowAttachment(row));
  }

  countForStep(input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
  }): Promise<number> {
    // `removedAt: null` is the point. A step whose evidence was detached no longer
    // satisfies its requirement, which stops "attach, get approved, detach" being a way
    // around it.
    return this.delegate.count({ where: { ...input, removedAt: null } });
  }
}
