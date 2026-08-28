import type {
  DatabaseRow,
  IdempotencyRecord,
  WorkflowDecisionRecord,
  WorkflowInstanceRecord,
  WorkflowSlaRecord,
  WorkflowVersionRecord,
  WorkflowDefinitionRecord,
  WorkflowEscalationRecord,
} from '@trustos/workflow-core';
import type { SlaStore } from '@trustos/workflow-sla';
import type { EscalationStore } from '@trustos/workflow-escalation';
import type { RoundRobinCursor } from '@trustos/workflow-tasks';
import type { DecisionStore, InstanceStore, VersionStore } from './engine';
import type { DefinitionStore, DefinitionVersionStore } from './definition-service';
import type { IdempotencyStore } from './idempotency';

/**
 * Prisma-backed stores for the runtime.
 *
 * Narrow delegates rather than a `PrismaClient`, for the reason phase 2 found: the
 * framework's client and a generated application's come from different schemas and are
 * not structurally assignable, so naming the capability keeps these usable with either.
 *
 * The pattern to notice is `updateMany` wherever a version is involved. `update` on a
 * primary key throws when nothing matches; `updateMany` returns a count, and a count of
 * zero is how an optimistic-lock failure is reported without an exception. Every store
 * here that takes an `expectedVersion` returns `null` on a conflict, and the service
 * layer turns that into a 409 with both version numbers.
 */

export interface GenericDelegate<TRow> {
  findFirst(args: { where: Record<string, unknown> }): Promise<TRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Array<Record<string, unknown>>;
    skip?: number;
    take?: number;
  }): Promise<TRow[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<TRow>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<TRow>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
  delete?(args: { where: Record<string, unknown> }): Promise<TRow>;
  deleteMany?(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

// --- instances -------------------------------------------------------------

/**
 * Rows as the database returns them.
 *
 * `DatabaseRow` widens every narrowed union to `string` and every Json column to `unknown`,
 * because that is what a generated Prisma client produces. The header of `DatabaseRow` in
 * `@trustos/workflow-core` explains why a port that named the narrowed type would be
 * unusable with the client it exists to accept.
 */
type InstanceRow = DatabaseRow<WorkflowInstanceRecord>;
type DecisionRow = DatabaseRow<WorkflowDecisionRecord>;
type VersionRow = DatabaseRow<WorkflowVersionRecord>;
type DefinitionRow = DatabaseRow<WorkflowDefinitionRecord>;
type SlaRow = DatabaseRow<WorkflowSlaRecord>;
type EscalationRow = DatabaseRow<WorkflowEscalationRecord>;
type IdempotencyRow = DatabaseRow<IdempotencyRecord>;

export class PrismaInstanceStore implements InstanceStore {
  constructor(private readonly delegate: GenericDelegate<InstanceRow>) {}

  async findById(id: string, organizationId: string): Promise<WorkflowInstanceRecord | null> {
    const row = await this.delegate.findFirst({ where: { id, organizationId } });
    return row ? (row as WorkflowInstanceRecord) : null;
  }

  async create(
    input: Omit<WorkflowInstanceRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowInstanceRecord> {
    return (await this.delegate.create({ data: { ...input } })) as WorkflowInstanceRecord;
  }

  /**
   * The optimistic lock.
   *
   * The version the reader saw is in the `where`, so a decision made against a stale page
   * updates zero rows rather than overwriting whatever the instance became. Returning
   * null lets the engine report the conflict with both version numbers, which is what
   * tells a client whether to reload or to give up.
   */
  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<WorkflowInstanceRecord>;
  }): Promise<WorkflowInstanceRecord | null> {
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

  async list(query: {
    organizationId: string;
    status?: string[];
    workflowDefinitionId?: string;
    currentState?: string[];
    businessObjectType?: string;
    businessObjectId?: string;
    page: number;
    pageSize: number;
  }) {
    const where: Record<string, unknown> = { organizationId: query.organizationId };
    if (query.status) where.status = { in: query.status };
    if (query.currentState) where.currentState = { in: query.currentState };
    if (query.workflowDefinitionId) where.workflowDefinitionId = query.workflowDefinitionId;
    if (query.businessObjectType) where.businessObjectType = query.businessObjectType;
    if (query.businessObjectId) where.businessObjectId = query.businessObjectId;

    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { startedAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.delegate.count({ where }),
    ]);

    return {
      items: rows as WorkflowInstanceRecord[],
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findActiveForObject(input: {
    organizationId: string;
    businessObjectType: string;
    businessObjectId: string;
  }): Promise<WorkflowInstanceRecord | null> {
    const row = await this.delegate.findFirst({ where: { ...input, status: 'active' } });
    return row ? (row as WorkflowInstanceRecord) : null;
  }
}

// --- decisions -------------------------------------------------------------

export class PrismaDecisionStore implements DecisionStore {
  constructor(private readonly delegate: GenericDelegate<DecisionRow>) {}

  async create(input: Omit<WorkflowDecisionRecord, 'id'>): Promise<WorkflowDecisionRecord> {
    return (await this.delegate.create({ data: { ...input } })) as WorkflowDecisionRecord;
  }

  /**
   * Decisions for one step and one rework cycle.
   *
   * The cycle filter is the load-bearing part. After a return for rework the maker may
   * change the fields an approver looked at, so an approval from a previous cycle is an
   * approval of a different request — counting it would let a maker inherit an approval
   * for an amount nobody approved.
   */
  async listForStep(input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
    reworkCycle: number;
  }): Promise<WorkflowDecisionRecord[]> {
    const rows = await this.delegate.findMany({
      where: input,
      orderBy: { decidedAt: 'asc' },
    });
    return rows as WorkflowDecisionRecord[];
  }

  async listForInstance(
    workflowInstanceId: string,
    organizationId: string,
  ): Promise<WorkflowDecisionRecord[]> {
    const rows = await this.delegate.findMany({
      where: { workflowInstanceId, organizationId },
      orderBy: { decidedAt: 'asc' },
    });
    return rows as WorkflowDecisionRecord[];
  }
}

// --- versions --------------------------------------------------------------

export class PrismaVersionStore implements VersionStore, DefinitionVersionStore {
  constructor(
    private readonly versions: GenericDelegate<VersionRow>,
    private readonly instances: GenericDelegate<InstanceRow>,
    private readonly definitions: GenericDelegate<DefinitionRow>,
  ) {}

  async findById(id: string): Promise<WorkflowVersionRecord | null> {
    const row = await this.versions.findFirst({ where: { id } });
    return row ? (row as WorkflowVersionRecord) : null;
  }

  async findByVersion(input: {
    workflowDefinitionId: string;
    version: string;
  }): Promise<WorkflowVersionRecord | null> {
    const row = await this.versions.findFirst({ where: input });
    return row ? (row as WorkflowVersionRecord) : null;
  }

  async listForDefinition(workflowDefinitionId: string): Promise<WorkflowVersionRecord[]> {
    const rows = await this.versions.findMany({
      where: { workflowDefinitionId },
      orderBy: { createdAt: 'desc' },
    });
    return rows as WorkflowVersionRecord[];
  }

  /**
   * The published version for a key.
   *
   * An organization's own definition wins over a platform-owned one with the same key.
   * That ordering is the extension mechanism: a tenant can publish their own version of a
   * framework workflow, and the framework's remains available to everybody who has not.
   *
   * Two queries rather than one `OR`, so the preference is explicit in the code rather
   * than depending on how the database happens to order a disjunction.
   */
  async findPublished(input: {
    organizationId: string;
    definitionKey: string;
  }): Promise<WorkflowVersionRecord | null> {
    const own = await this.definitions.findFirst({
      where: { organizationId: input.organizationId, key: input.definitionKey, deletedAt: null },
    });

    if (own) {
      const version = await this.versions.findFirst({
        where: { workflowDefinitionId: own.id, status: 'published' },
      });
      if (version) return version as WorkflowVersionRecord;
    }

    const global = await this.definitions.findFirst({
      where: { organizationId: null, key: input.definitionKey, deletedAt: null },
    });
    if (!global) return null;

    const version = await this.versions.findFirst({
      where: { workflowDefinitionId: global.id, status: 'published' },
    });
    return version ? (version as WorkflowVersionRecord) : null;
  }

  async create(
    input: Omit<WorkflowVersionRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowVersionRecord> {
    return (await this.versions.create({ data: { ...input } })) as WorkflowVersionRecord;
  }

  async update(input: {
    id: string;
    patch: Partial<WorkflowVersionRecord>;
  }): Promise<WorkflowVersionRecord> {
    // No optimistic lock on a version, deliberately. A published version is immutable —
    // enforced by the application, by the hash check on every compile, and by a database
    // trigger — so the only updates are status transitions, and those are guarded by
    // `assertStatusTransition` rather than by a version counter.
    return (await this.versions.update({
      where: { id: input.id },
      data: { ...input.patch },
    })) as WorkflowVersionRecord;
  }

  /**
   * Instances still running on a version.
   *
   * Reported when a version is retired rather than blocking it: an operator retiring a
   * version usually knows there are instances on it, and blocking would mean waiting
   * weeks for the last one to finish.
   */
  countActiveInstances(versionId: string): Promise<number> {
    return this.instances.count({ where: { workflowVersionId: versionId, status: 'active' } });
  }
}

// --- definitions -----------------------------------------------------------

export class PrismaDefinitionStore implements DefinitionStore {
  constructor(private readonly delegate: GenericDelegate<DefinitionRow>) {}

  async findByKey(input: {
    organizationId: string;
    key: string;
  }): Promise<WorkflowDefinitionRecord | null> {
    const row = await this.delegate.findFirst({ where: { ...input, deletedAt: null } });
    return row ? (row as WorkflowDefinitionRecord) : null;
  }

  async findById(
    id: string,
    organizationId: string | null,
  ): Promise<WorkflowDefinitionRecord | null> {
    // A global definition (null organization) is readable by everybody, so the filter is
    // an `OR` rather than an equality — otherwise a tenant could not read the framework's
    // own workflows.
    const row = await this.delegate.findFirst({
      where: {
        id,
        deletedAt: null,
        OR: [{ organizationId }, { organizationId: null }],
      },
    });
    return row ? (row as WorkflowDefinitionRecord) : null;
  }

  async create(
    input: Omit<WorkflowDefinitionRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<WorkflowDefinitionRecord> {
    return (await this.delegate.create({ data: { ...input } })) as WorkflowDefinitionRecord;
  }

  async list(input: {
    organizationId: string;
    includeGlobal?: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ items: WorkflowDefinitionRecord[]; total: number }> {
    const where = {
      deletedAt: null,
      ...(input.includeGlobal
        ? { OR: [{ organizationId: input.organizationId }, { organizationId: null }] }
        : { organizationId: input.organizationId }),
    };

    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.delegate.count({ where }),
    ]);

    return { items: rows as WorkflowDefinitionRecord[], total };
  }
}

// --- SLA -------------------------------------------------------------------

export class PrismaSlaStore implements SlaStore {
  constructor(private readonly delegate: GenericDelegate<SlaRow>) {}

  async findById(id: string, organizationId: string): Promise<WorkflowSlaRecord | null> {
    const row = await this.delegate.findFirst({ where: { id, organizationId } });
    return row ? (row as WorkflowSlaRecord) : null;
  }

  async create(
    input: Omit<WorkflowSlaRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowSlaRecord> {
    return (await this.delegate.create({ data: { ...input } })) as WorkflowSlaRecord;
  }

  async update(input: {
    id: string;
    organizationId: string;
    patch: Partial<WorkflowSlaRecord>;
  }): Promise<WorkflowSlaRecord> {
    return (await this.delegate.update({
      where: { id: input.id },
      data: { ...input.patch },
    })) as WorkflowSlaRecord;
  }

  async listForInstance(instanceId: string, organizationId: string): Promise<WorkflowSlaRecord[]> {
    const rows = await this.delegate.findMany({
      where: { workflowInstanceId: instanceId, organizationId },
      orderBy: { startedAt: 'asc' },
    });
    return rows as WorkflowSlaRecord[];
  }

  async listForTask(taskId: string, organizationId: string): Promise<WorkflowSlaRecord[]> {
    const rows = await this.delegate.findMany({
      where: { workflowTaskId: taskId, organizationId },
    });
    return rows as WorkflowSlaRecord[];
  }

  /**
   * SLAs whose warning threshold has passed and whose notification has not fired.
   *
   * `warnedAt: null` in the `where` is what makes the sweep idempotent at the query
   * level: an SLA that already warned is not returned again, so a scheduler running twice
   * in one minute does nothing the second time.
   */
  async listDueForWarning(input: {
    asOf: Date;
    limit: number;
    organizationId?: string;
  }): Promise<WorkflowSlaRecord[]> {
    const rows = await this.delegate.findMany({
      where: {
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        status: { in: ['active', 'warning'] },
        warningAt: { lte: input.asOf },
        warnedAt: null,
      },
      orderBy: { warningAt: 'asc' },
      take: input.limit,
    });
    return rows as WorkflowSlaRecord[];
  }

  async listDueForBreach(input: {
    asOf: Date;
    limit: number;
    organizationId?: string;
  }): Promise<WorkflowSlaRecord[]> {
    const rows = await this.delegate.findMany({
      where: {
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        status: { in: ['active', 'warning', 'breached'] },
        dueAt: { lte: input.asOf },
        breachedAt: null,
      },
      orderBy: { dueAt: 'asc' },
      take: input.limit,
    });
    return rows as WorkflowSlaRecord[];
  }

  /**
   * Claims the warning, atomically.
   *
   * Conditional on `warnedAt` still being null, so two schedulers produce one claim and
   * one null. Without this the same breach pages somebody once per scheduler per sweep.
   */
  async markWarned(id: string, at: Date): Promise<WorkflowSlaRecord | null> {
    const result = await this.delegate.updateMany({
      where: { id, warnedAt: null },
      data: { warnedAt: at, status: 'warning' },
    });
    if (result.count === 0) return null;
    const row = await this.delegate.findFirst({ where: { id } });
    return row ? (row as WorkflowSlaRecord) : null;
  }

  async markBreached(id: string, at: Date): Promise<WorkflowSlaRecord | null> {
    const result = await this.delegate.updateMany({
      where: { id, breachedAt: null },
      data: { breachedAt: at, status: 'breached' },
    });
    if (result.count === 0) return null;
    const row = await this.delegate.findFirst({ where: { id } });
    return row ? (row as WorkflowSlaRecord) : null;
  }
}

// --- escalation ------------------------------------------------------------

export class PrismaEscalationStore implements EscalationStore {
  constructor(private readonly delegate: GenericDelegate<EscalationRow>) {}

  /**
   * Claims an escalation, or reports that it already fired.
   *
   * A plain insert, relying on the unique index over
   * `(organizationId, idempotencyKey)`. A `SELECT` first would have a window between the
   * check and the insert, and two schedulers hitting that window produce two escalations
   * for one breach — which at three in the morning is a pager going off twice.
   */
  async claim(
    input: Omit<
      WorkflowEscalationRecord,
      'id' | 'completedAt' | 'attempts' | 'status' | 'lastError'
    >,
  ): Promise<WorkflowEscalationRecord | null> {
    try {
      return (await this.delegate.create({
        data: { ...input, status: 'pending', attempts: 0, lastError: null },
      })) as WorkflowEscalationRecord;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async update(input: {
    id: string;
    organizationId: string;
    patch: Partial<WorkflowEscalationRecord>;
  }): Promise<WorkflowEscalationRecord> {
    return (await this.delegate.update({
      where: { id: input.id },
      data: { ...input.patch },
    })) as WorkflowEscalationRecord;
  }

  async listForInstance(
    instanceId: string,
    organizationId: string,
  ): Promise<WorkflowEscalationRecord[]> {
    const rows = await this.delegate.findMany({
      where: { workflowInstanceId: instanceId, organizationId },
      orderBy: { triggeredAt: 'desc' },
    });
    return rows as WorkflowEscalationRecord[];
  }

  async findByKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<WorkflowEscalationRecord | null> {
    const row = await this.delegate.findFirst({ where: { organizationId, idempotencyKey } });
    return row ? (row as WorkflowEscalationRecord) : null;
  }
}

// --- idempotency -----------------------------------------------------------

export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly delegate: GenericDelegate<IdempotencyRow>) {}

  /**
   * Claims a key with a single insert.
   *
   * The unique index does the work. On a violation the existing row is read and returned,
   * and the caller decides: same payload and completed → replay the reference, different
   * payload → refuse, still in progress → refuse.
   *
   * An expired row is treated as absent and replaced, so a key becomes reusable after its
   * window rather than being burned forever.
   */
  async claim(
    input: Omit<IdempotencyRecord, 'id' | 'createdAt' | 'completedAt' | 'status'>,
  ): Promise<{ claimed: boolean; existing: IdempotencyRecord | null }> {
    try {
      await this.delegate.create({ data: { ...input, status: 'in_progress' } });
      return { claimed: true, existing: null };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.delegate.findFirst({
        where: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      });

      if (existing && existing.expiresAt.getTime() <= Date.now()) {
        // Expired. Reclaim it in place, conditionally on it still being the expired row
        // this caller saw — so two callers racing on an expired key still produce one
        // winner.
        const reclaimed = await this.delegate.updateMany({
          where: { id: existing.id, expiresAt: existing.expiresAt },
          data: {
            actorId: input.actorId,
            operation: input.operation,
            requestHash: input.requestHash,
            responseReference: null,
            status: 'in_progress',
            expiresAt: input.expiresAt,
            completedAt: null,
          },
        });
        if (reclaimed.count === 1) return { claimed: true, existing: null };
      }

      return { claimed: false, existing: existing as IdempotencyRecord | null };
    }
  }

  async complete(input: {
    organizationId: string;
    idempotencyKey: string;
    responseReference: string;
  }): Promise<void> {
    await this.delegate.updateMany({
      where: {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      },
      data: {
        status: 'completed',
        responseReference: input.responseReference,
        completedAt: new Date(),
      },
    });
  }

  async fail(input: { organizationId: string; idempotencyKey: string }): Promise<void> {
    // Failed rather than deleted: deleting would let an immediate retry with the same key
    // through, and a caller retrying a request that failed for a business reason would
    // get the same refusal. Keeping the row tells them a new attempt needs a new key.
    await this.delegate.updateMany({
      where: {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      },
      data: { status: 'failed', completedAt: new Date() },
    });
  }

  async find(organizationId: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    const row = await this.delegate.findFirst({ where: { organizationId, idempotencyKey } });
    return row ? (row as IdempotencyRecord) : null;
  }

  async purgeExpired(asOf: Date, limit: number): Promise<number> {
    if (!this.delegate.deleteMany) return 0;
    // Bounded, so a purge on a table that grew unnoticed does not lock it for a minute.
    const stale = await this.delegate.findMany({
      where: { expiresAt: { lte: asOf } },
      take: limit,
    });
    if (stale.length === 0) return 0;

    const result = await this.delegate.deleteMany({
      where: { id: { in: stale.map((record) => record.id) } },
    });
    return result.count;
  }
}

// --- round robin -----------------------------------------------------------

/**
 * Persisted round-robin cursor.
 *
 * `upsert` with an increment, which Postgres executes as one statement — so two
 * concurrent assignments get different positions rather than both reading the same one.
 * An in-memory cursor is only correct in a single process, and a counter that resets on
 * every deploy sends every task after a restart to the same person.
 */
export interface CursorDelegate {
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<{ position: number }>;
}

export class PrismaRoundRobinCursor implements RoundRobinCursor {
  constructor(private readonly delegate: CursorDelegate) {}

  async next(organizationId: string, key: string, populationSize: number): Promise<number> {
    if (populationSize <= 0) return 0;

    const row = await this.delegate.upsert({
      where: { organizationId_cursorKey: { organizationId, cursorKey: key } },
      create: { organizationId, cursorKey: key, position: 1 },
      update: { position: { increment: 1 } },
    });

    // The row holds the *next* position, so the one just handed out is one behind. The
    // modulo is applied on read rather than on write, so the population changing size
    // does not require rewriting the stored counter.
    return (row.position - 1) % populationSize;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
