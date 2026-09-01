import type {
  CaseRecord,
  CaseStatus,
  WorkflowDecisionRecord,
  WorkflowDefinitionRecord,
  WorkflowEscalationRecord,
  WorkflowEventRecord,
  WorkflowInstanceRecord,
  WorkflowSlaRecord,
  WorkflowTaskRecord,
  WorkflowVersionRecord,
} from '@trustsystem/workflow-core';
import type { EscalationStore } from '@trustsystem/workflow-escalation';
import type { HistoryPage, HistoryQuery, HistoryStore } from '@trustsystem/workflow-history';
import type { SlaStore } from '@trustsystem/workflow-sla';
import type { TaskListQuery, TaskPage, TaskStore } from '@trustsystem/workflow-tasks';
import type { DecisionStore, InstanceStore, VersionStore } from './engine';
import type { DefinitionStore, DefinitionVersionStore } from './definition-service';

/**
 * In-memory stores.
 *
 * Exported rather than kept in a test file, because a boot test, a local development run
 * and every package's own suite all need them — and the alternative is that each writes
 * its own, one of them forgets to filter by organization, and the cross-tenant test that
 * would have caught it is passing against a store that has no boundary.
 *
 * They model the two behaviours the real stores are relied on for:
 *
 *   * **Organization filtering.** Every lookup takes an organization and returns null for
 *     a record in another one, exactly as the Prisma stores do.
 *   * **Optimistic locking.** Every conditional update compares the version and returns
 *     null on a mismatch, so a concurrency test exercises the real code path rather than
 *     a store that always succeeds.
 *
 * They are not for production: nothing is indexed, nothing survives a restart, and
 * `claim` is only atomic because JavaScript is single-threaded.
 */

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

/** Resets ids so a test asserting on one is not order-dependent. */
export function resetInMemoryIds(): void {
  counter = 0;
}

// --- instances -------------------------------------------------------------

export class InMemoryInstanceStore implements InstanceStore {
  readonly records = new Map<string, WorkflowInstanceRecord>();

  async findById(id: string, organizationId: string): Promise<WorkflowInstanceRecord | null> {
    const record = this.records.get(id);
    return record && record.organizationId === organizationId ? { ...record } : null;
  }

  async create(
    input: Omit<WorkflowInstanceRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowInstanceRecord> {
    const now = new Date();
    const record: WorkflowInstanceRecord = {
      ...input,
      id: nextId('wfi'),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<WorkflowInstanceRecord>;
  }): Promise<WorkflowInstanceRecord | null> {
    const record = this.records.get(input.id);
    if (!record) return null;
    if (record.organizationId !== input.organizationId) return null;
    // The optimistic lock, modelled faithfully: a mismatch returns null rather than
    // throwing, which is what makes a concurrency test exercise the real path.
    if (record.version !== input.expectedVersion) return null;

    const updated: WorkflowInstanceRecord = {
      ...record,
      ...input.patch,
      version: record.version + 1,
      updatedAt: new Date(),
    };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async list(query: {
    organizationId: string;
    status?: string[];
    currentState?: string[];
    workflowDefinitionId?: string;
    businessObjectType?: string;
    businessObjectId?: string;
    page: number;
    pageSize: number;
  }) {
    const all = [...this.records.values()]
      .filter((record) => record.organizationId === query.organizationId)
      .filter((record) => !query.status || query.status.includes(record.status))
      .filter((record) => !query.currentState || query.currentState.includes(record.currentState))
      .filter(
        (record) =>
          !query.workflowDefinitionId || record.workflowDefinitionId === query.workflowDefinitionId,
      )
      .filter(
        (record) =>
          !query.businessObjectType || record.businessObjectType === query.businessObjectType,
      )
      .filter(
        (record) => !query.businessObjectId || record.businessObjectId === query.businessObjectId,
      )
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const start = (query.page - 1) * query.pageSize;

    return {
      items: all.slice(start, start + query.pageSize).map((record) => ({ ...record })),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findActiveForObject(input: {
    organizationId: string;
    businessObjectType: string;
    businessObjectId: string;
  }): Promise<WorkflowInstanceRecord | null> {
    return (
      [...this.records.values()].find(
        (record) =>
          record.organizationId === input.organizationId &&
          record.businessObjectType === input.businessObjectType &&
          record.businessObjectId === input.businessObjectId &&
          record.status === 'active',
      ) ?? null
    );
  }
}

// --- decisions -------------------------------------------------------------

export class InMemoryDecisionStore implements DecisionStore {
  readonly records: WorkflowDecisionRecord[] = [];

  async create(input: Omit<WorkflowDecisionRecord, 'id'>): Promise<WorkflowDecisionRecord> {
    const record: WorkflowDecisionRecord = { ...input, id: nextId('wdec') };
    this.records.push(record);
    return { ...record };
  }

  async listForStep(input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
    reworkCycle: number;
  }): Promise<WorkflowDecisionRecord[]> {
    // The rework-cycle filter is the load-bearing part, and it is modelled here so that
    // a test asserting "an approval does not carry across a rework" exercises it.
    return this.records
      .filter(
        (record) =>
          record.organizationId === input.organizationId &&
          record.workflowInstanceId === input.workflowInstanceId &&
          record.stepKey === input.stepKey &&
          record.reworkCycle === input.reworkCycle,
      )
      .map((record) => ({ ...record }));
  }

  async listForInstance(
    workflowInstanceId: string,
    organizationId: string,
  ): Promise<WorkflowDecisionRecord[]> {
    return this.records
      .filter(
        (record) =>
          record.workflowInstanceId === workflowInstanceId &&
          record.organizationId === organizationId,
      )
      .map((record) => ({ ...record }));
  }
}

// --- definitions and versions ---------------------------------------------

export class InMemoryDefinitionStore implements DefinitionStore {
  readonly records = new Map<string, WorkflowDefinitionRecord>();

  async findByKey(input: {
    organizationId: string;
    key: string;
  }): Promise<WorkflowDefinitionRecord | null> {
    return (
      [...this.records.values()].find(
        (record) =>
          record.key === input.key &&
          record.organizationId === input.organizationId &&
          !record.deletedAt,
      ) ?? null
    );
  }

  async findById(
    id: string,
    organizationId: string | null,
  ): Promise<WorkflowDefinitionRecord | null> {
    const record = this.records.get(id);
    if (!record || record.deletedAt) return null;
    // A global definition is readable by everybody, which is why this is not an equality
    // check.
    if (record.organizationId !== null && record.organizationId !== organizationId) return null;
    return { ...record };
  }

  async create(
    input: Omit<WorkflowDefinitionRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<WorkflowDefinitionRecord> {
    const now = new Date();
    const record: WorkflowDefinitionRecord = {
      ...input,
      id: nextId('wd'),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async list(input: {
    organizationId: string;
    includeGlobal?: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ items: WorkflowDefinitionRecord[]; total: number }> {
    const all = [...this.records.values()].filter(
      (record) =>
        !record.deletedAt &&
        (record.organizationId === input.organizationId ||
          (input.includeGlobal && record.organizationId === null)),
    );
    const start = (input.page - 1) * input.pageSize;
    return { items: all.slice(start, start + input.pageSize), total: all.length };
  }
}

export class InMemoryVersionStore implements VersionStore, DefinitionVersionStore {
  readonly records = new Map<string, WorkflowVersionRecord>();

  constructor(
    private readonly definitions: InMemoryDefinitionStore,
    private readonly instances?: InMemoryInstanceStore,
  ) {}

  async findById(id: string): Promise<WorkflowVersionRecord | null> {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  async findByVersion(input: {
    workflowDefinitionId: string;
    version: string;
  }): Promise<WorkflowVersionRecord | null> {
    return (
      [...this.records.values()].find(
        (record) =>
          record.workflowDefinitionId === input.workflowDefinitionId &&
          record.version === input.version,
      ) ?? null
    );
  }

  async listForDefinition(workflowDefinitionId: string): Promise<WorkflowVersionRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.workflowDefinitionId === workflowDefinitionId)
      .map((record) => ({ ...record }));
  }

  async findPublished(input: {
    organizationId: string;
    definitionKey: string;
  }): Promise<WorkflowVersionRecord | null> {
    // An organization's own definition wins over a platform-owned one with the same key —
    // the same preference the Prisma store implements, modelled so a test of the
    // extension mechanism is meaningful.
    const own = await this.definitions.findByKey({
      organizationId: input.organizationId,
      key: input.definitionKey,
    });

    if (own) {
      const version = [...this.records.values()].find(
        (record) => record.workflowDefinitionId === own.id && record.status === 'published',
      );
      if (version) return { ...version };
    }

    const global = [...this.definitions.records.values()].find(
      (record) =>
        record.organizationId === null && record.key === input.definitionKey && !record.deletedAt,
    );
    if (!global) return null;

    const version = [...this.records.values()].find(
      (record) => record.workflowDefinitionId === global.id && record.status === 'published',
    );
    return version ? { ...version } : null;
  }

  async create(
    input: Omit<WorkflowVersionRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowVersionRecord> {
    const now = new Date();
    const record: WorkflowVersionRecord = {
      ...input,
      id: nextId('wv'),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(input: {
    id: string;
    patch: Partial<WorkflowVersionRecord>;
  }): Promise<WorkflowVersionRecord> {
    const record = this.records.get(input.id);
    if (!record) throw new Error(`no version ${input.id}`);

    /*
     * Published immutability, modelled.
     *
     * The database enforces this with a trigger; the in-memory store enforces it here so
     * a test does not accidentally rely on being able to edit a published version and
     * then pass against a database that refuses.
     */
    if (
      (record.status === 'published' || record.status === 'retired') &&
      (input.patch.definition !== undefined ||
        input.patch.definitionHash !== undefined ||
        input.patch.version !== undefined)
    ) {
      throw new Error(
        `Version ${record.version} is ${record.status} and its definition is immutable.`,
      );
    }

    const updated = { ...record, ...input.patch, updatedAt: new Date() };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async countActiveInstances(versionId: string): Promise<number> {
    if (!this.instances) return 0;
    return [...this.instances.records.values()].filter(
      (record) => record.workflowVersionId === versionId && record.status === 'active',
    ).length;
  }
}

// --- tasks -----------------------------------------------------------------

export class InMemoryTaskStore implements TaskStore {
  readonly records = new Map<string, WorkflowTaskRecord>();
  /**
   * Test hook: runs between the read and the write inside `claim`.
   *
   * The only way to exercise the claim race deterministically. JavaScript is
   * single-threaded, so two `await`ed claims never truly interleave — this lets a test
   * make somebody else claim the task at exactly the moment the first claim has read the
   * row and not yet written it, which is the window the version check exists to close.
   */
  onBeforeClaimWrite?: () => void | Promise<void>;

  async findById(id: string, organizationId: string): Promise<WorkflowTaskRecord | null> {
    const record = this.records.get(id);
    return record && record.organizationId === organizationId ? { ...record } : null;
  }

  async list(query: TaskListQuery): Promise<TaskPage> {
    const all = [...this.records.values()]
      .filter((record) => record.organizationId === query.organizationId)
      .filter((record) => !query.status || query.status.includes(record.status))
      .filter(
        (record) =>
          !query.workflowInstanceId || record.workflowInstanceId === query.workflowInstanceId,
      )
      .filter((record) => !query.priority || query.priority.includes(record.priority))
      .filter((record) => {
        if (!query.dueBefore) return true;
        return record.dueAt !== null && record.dueAt.getTime() <= query.dueBefore.getTime();
      })
      .filter((record) => {
        if (query.assigneeUserId) {
          // Assigned *or* claimed: a task pulled from a pool is theirs even though
          // `assigneeUserId` may still be null.
          return (
            record.assigneeUserId === query.assigneeUserId ||
            record.claimedById === query.assigneeUserId
          );
        }
        if (query.eligibleFor) {
          const { roles, groupIds, userId } = query.eligibleFor;
          if (record.assigneeUserId === userId) return true;
          if (record.claimedById) return false;
          if (record.assigneeRole && roles.includes(record.assigneeRole)) return true;
          if (record.assigneeGroupId && groupIds.includes(record.assigneeGroupId)) return true;
          return false;
        }
        return true;
      });

    const start = (query.page - 1) * query.pageSize;

    return {
      items: all.slice(start, start + query.pageSize).map((record) => ({ ...record })),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(
    input: Omit<WorkflowTaskRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowTaskRecord> {
    const now = new Date();
    const record: WorkflowTaskRecord = {
      ...input,
      id: nextId('wft'),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async claim(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    claimedById: string;
    claimedAt: Date;
  }): Promise<WorkflowTaskRecord | null> {
    // The hook fires *before* the condition is evaluated, so a competing claim inside it
    // changes the version the check then sees. That is what makes the race real rather
    // than simulated.
    await this.onBeforeClaimWrite?.();

    const record = this.records.get(input.id);
    if (!record) return null;
    if (record.organizationId !== input.organizationId) return null;
    if (record.version !== input.expectedVersion) return null;
    if (record.claimedById) return null;
    if (record.status !== 'open' && record.status !== 'assigned') return null;

    const updated: WorkflowTaskRecord = {
      ...record,
      claimedById: input.claimedById,
      claimedAt: input.claimedAt,
      status: 'claimed',
      version: record.version + 1,
      updatedAt: new Date(),
    };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<WorkflowTaskRecord>;
  }): Promise<WorkflowTaskRecord | null> {
    const record = this.records.get(input.id);
    if (!record) return null;
    if (record.organizationId !== input.organizationId) return null;
    if (record.version !== input.expectedVersion) return null;

    const updated: WorkflowTaskRecord = {
      ...record,
      ...input.patch,
      version: record.version + 1,
      updatedAt: new Date(),
    };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async cancelForInstance(input: {
    workflowInstanceId: string;
    organizationId: string;
    at: Date;
    reason: string;
  }): Promise<number> {
    let cancelled = 0;
    for (const [id, record] of this.records) {
      if (record.workflowInstanceId !== input.workflowInstanceId) continue;
      if (record.organizationId !== input.organizationId) continue;
      if (!['open', 'assigned', 'claimed', 'in_progress'].includes(record.status)) continue;

      this.records.set(id, {
        ...record,
        status: 'cancelled',
        outcome: input.reason,
        completedAt: input.at,
        version: record.version + 1,
      });
      cancelled += 1;
    }
    return cancelled;
  }

  async listOverdue(input: {
    organizationId?: string;
    asOf: Date;
    limit: number;
  }): Promise<WorkflowTaskRecord[]> {
    return [...this.records.values()]
      .filter((record) => !input.organizationId || record.organizationId === input.organizationId)
      .filter((record) => ['open', 'assigned', 'claimed', 'in_progress'].includes(record.status))
      .filter((record) => record.dueAt !== null && record.dueAt.getTime() <= input.asOf.getTime())
      .slice(0, input.limit)
      .map((record) => ({ ...record }));
  }

  async countOpenByAssignee(
    organizationId: string,
  ): Promise<Array<{ userId: string; count: number }>> {
    const counts = new Map<string, number>();
    for (const record of this.records.values()) {
      if (record.organizationId !== organizationId) continue;
      if (!['open', 'assigned', 'claimed', 'in_progress'].includes(record.status)) continue;
      const holder = record.claimedById ?? record.assigneeUserId;
      if (!holder) continue;
      counts.set(holder, (counts.get(holder) ?? 0) + 1);
    }
    return [...counts].map(([userId, count]) => ({ userId, count }));
  }
}

// --- history ---------------------------------------------------------------

export class InMemoryHistoryStore implements HistoryStore {
  readonly records: WorkflowEventRecord[] = [];

  async append(input: Omit<WorkflowEventRecord, 'id' | 'sequence'>): Promise<WorkflowEventRecord> {
    const sequence = input.workflowInstanceId
      ? this.records.filter((record) => record.workflowInstanceId === input.workflowInstanceId)
          .length + 1
      : 0;

    const record: WorkflowEventRecord = { ...input, id: nextId('wfe'), sequence };
    this.records.push(record);
    return { ...record };
  }

  async query(query: HistoryQuery): Promise<HistoryPage> {
    const all = this.records
      .filter((record) => record.organizationId === query.organizationId)
      .filter(
        (record) =>
          !query.workflowInstanceId || record.workflowInstanceId === query.workflowInstanceId,
      )
      .filter((record) => !query.caseId || record.caseId === query.caseId)
      .filter((record) => !query.types || query.types.includes(record.type))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    const start = (query.page - 1) * query.pageSize;

    return {
      items: all.slice(start, start + query.pageSize),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async recent(input: {
    organizationId: string;
    workflowInstanceId: string;
    limit: number;
  }): Promise<WorkflowEventRecord[]> {
    return this.records
      .filter(
        (record) =>
          record.organizationId === input.organizationId &&
          record.workflowInstanceId === input.workflowInstanceId,
      )
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, input.limit);
  }

  async count(input: { organizationId: string; workflowInstanceId: string }): Promise<number> {
    return this.records.filter(
      (record) =>
        record.organizationId === input.organizationId &&
        record.workflowInstanceId === input.workflowInstanceId,
    ).length;
  }

  /** Convenience for tests: every event of a type, in order. */
  byType(type: string): WorkflowEventRecord[] {
    return this.records.filter((record) => record.type === type);
  }
}

// --- SLA -------------------------------------------------------------------

export class InMemorySlaStore implements SlaStore {
  readonly records = new Map<string, WorkflowSlaRecord>();

  async findById(id: string, organizationId: string): Promise<WorkflowSlaRecord | null> {
    const record = this.records.get(id);
    return record && record.organizationId === organizationId ? { ...record } : null;
  }

  async create(
    input: Omit<WorkflowSlaRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowSlaRecord> {
    const now = new Date();
    const record: WorkflowSlaRecord = {
      ...input,
      id: nextId('wsla'),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(input: {
    id: string;
    organizationId: string;
    patch: Partial<WorkflowSlaRecord>;
  }): Promise<WorkflowSlaRecord> {
    const record = this.records.get(input.id);
    if (!record) throw new Error(`no sla ${input.id}`);
    const updated = { ...record, ...input.patch, updatedAt: new Date() };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async listForInstance(instanceId: string, organizationId: string): Promise<WorkflowSlaRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.workflowInstanceId === instanceId && record.organizationId === organizationId,
      )
      .map((record) => ({ ...record }));
  }

  async listForTask(taskId: string, organizationId: string): Promise<WorkflowSlaRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) => record.workflowTaskId === taskId && record.organizationId === organizationId,
      )
      .map((record) => ({ ...record }));
  }

  async listDueForWarning(input: {
    asOf: Date;
    limit: number;
    organizationId?: string;
  }): Promise<WorkflowSlaRecord[]> {
    return (
      [...this.records.values()]
        .filter((record) => !input.organizationId || record.organizationId === input.organizationId)
        .filter((record) => ['active', 'warning'].includes(record.status))
        .filter((record) => record.warningAt.getTime() <= input.asOf.getTime())
        // The `warnedAt is null` filter is what makes the sweep idempotent at the query
        // level, so it is modelled here.
        .filter((record) => record.warnedAt === null)
        .slice(0, input.limit)
        .map((record) => ({ ...record }))
    );
  }

  async listDueForBreach(input: {
    asOf: Date;
    limit: number;
    organizationId?: string;
  }): Promise<WorkflowSlaRecord[]> {
    return [...this.records.values()]
      .filter((record) => !input.organizationId || record.organizationId === input.organizationId)
      .filter((record) => ['active', 'warning', 'breached'].includes(record.status))
      .filter((record) => record.dueAt.getTime() <= input.asOf.getTime())
      .filter((record) => record.breachedAt === null)
      .slice(0, input.limit)
      .map((record) => ({ ...record }));
  }

  async markWarned(id: string, at: Date): Promise<WorkflowSlaRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    // Conditional, so two sweeps produce one claim and one null.
    if (record.warnedAt !== null) return null;

    const updated: WorkflowSlaRecord = { ...record, warnedAt: at, status: 'warning' };
    this.records.set(id, updated);
    return { ...updated };
  }

  async markBreached(id: string, at: Date): Promise<WorkflowSlaRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.breachedAt !== null) return null;

    const updated: WorkflowSlaRecord = { ...record, breachedAt: at, status: 'breached' };
    this.records.set(id, updated);
    return { ...updated };
  }
}

// --- escalation ------------------------------------------------------------

export class InMemoryEscalationStore implements EscalationStore {
  readonly records = new Map<string, WorkflowEscalationRecord>();

  async claim(
    input: Omit<
      WorkflowEscalationRecord,
      'id' | 'completedAt' | 'attempts' | 'status' | 'lastError'
    >,
  ): Promise<WorkflowEscalationRecord | null> {
    // The unique constraint, modelled. Returning null on a duplicate is the whole
    // idempotency guarantee, so a test of "the sweep runs twice" is meaningful.
    const existing = [...this.records.values()].find(
      (record) =>
        record.organizationId === input.organizationId &&
        record.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return null;

    const record: WorkflowEscalationRecord = {
      ...input,
      id: nextId('wesc'),
      status: 'pending',
      attempts: 0,
      lastError: null,
      completedAt: null,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(input: {
    id: string;
    organizationId: string;
    patch: Partial<WorkflowEscalationRecord>;
  }): Promise<WorkflowEscalationRecord> {
    const record = this.records.get(input.id);
    if (!record) throw new Error(`no escalation ${input.id}`);
    const updated = { ...record, ...input.patch };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async listForInstance(
    instanceId: string,
    organizationId: string,
  ): Promise<WorkflowEscalationRecord[]> {
    return [...this.records.values()].filter(
      (record) =>
        record.workflowInstanceId === instanceId && record.organizationId === organizationId,
    );
  }

  async findByKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<WorkflowEscalationRecord | null> {
    return (
      [...this.records.values()].find(
        (record) =>
          record.organizationId === organizationId && record.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }
}

// --- cases -----------------------------------------------------------------

export class InMemoryCaseStore {
  readonly records = new Map<string, CaseRecord>();

  constructor(private readonly instances?: InMemoryInstanceStore) {}

  async findById(id: string, organizationId: string): Promise<CaseRecord | null> {
    const record = this.records.get(id);
    return record && record.organizationId === organizationId ? { ...record } : null;
  }

  async findByReference(reference: string, organizationId: string): Promise<CaseRecord | null> {
    return (
      [...this.records.values()].find(
        (record) => record.reference === reference && record.organizationId === organizationId,
      ) ?? null
    );
  }

  async create(
    input: Omit<CaseRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<CaseRecord> {
    const now = new Date();
    const record: CaseRecord = {
      ...input,
      id: nextId('case'),
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<CaseRecord>;
  }): Promise<CaseRecord | null> {
    const record = this.records.get(input.id);
    if (!record) return null;
    if (record.organizationId !== input.organizationId) return null;
    if (record.version !== input.expectedVersion) return null;

    const updated: CaseRecord = {
      ...record,
      ...input.patch,
      version: record.version + 1,
      updatedAt: new Date(),
    };
    this.records.set(input.id, updated);
    return { ...updated };
  }

  async list(query: {
    organizationId: string;
    status?: CaseStatus[];
    caseType?: string[];
    ownerId?: string;
    assignedTeam?: string;
    page: number;
    pageSize: number;
  }) {
    const all = [...this.records.values()]
      .filter((record) => record.organizationId === query.organizationId)
      .filter((record) => !query.status || query.status.includes(record.status))
      .filter((record) => !query.caseType || query.caseType.includes(record.caseType))
      .filter((record) => !query.ownerId || record.ownerId === query.ownerId)
      .filter((record) => !query.assignedTeam || record.assignedTeam === query.assignedTeam);

    const start = (query.page - 1) * query.pageSize;

    return {
      items: all.slice(start, start + query.pageSize).map((record) => ({ ...record })),
      total: all.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async listInstances(caseId: string, organizationId: string): Promise<WorkflowInstanceRecord[]> {
    if (!this.instances) return [];
    return [...this.instances.records.values()].filter(
      (record) => record.caseId === caseId && record.organizationId === organizationId,
    );
  }

  async countByStatus(
    organizationId: string,
  ): Promise<Array<{ status: CaseStatus; count: number }>> {
    const counts = new Map<CaseStatus, number>();
    for (const record of this.records.values()) {
      if (record.organizationId !== organizationId) continue;
      counts.set(record.status, (counts.get(record.status) ?? 0) + 1);
    }
    return [...counts].map(([status, count]) => ({ status, count }));
  }
}

/** A member directory over a fixed map, for tests. */
export class InMemoryMemberDirectory {
  constructor(
    private readonly members: Record<string, { roles: string[]; groups: string[] }> = {},
    private readonly organizationId = 'org_acme',
  ) {}

  async listByRole(organizationId: string, role: string): Promise<string[]> {
    if (organizationId !== this.organizationId) return [];
    // Sorted, because round-robin needs a stable order to be a rotation rather than a
    // shuffle.
    return Object.entries(this.members)
      .filter(([, member]) => member.roles.includes(role))
      .map(([userId]) => userId)
      .sort();
  }

  async listByGroup(organizationId: string, groupId: string): Promise<string[]> {
    if (organizationId !== this.organizationId) return [];
    return Object.entries(this.members)
      .filter(([, member]) => member.groups.includes(groupId))
      .map(([userId]) => userId)
      .sort();
  }

  async isActiveMember(organizationId: string, userId: string): Promise<boolean> {
    return organizationId === this.organizationId && userId in this.members;
  }
}
