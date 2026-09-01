import { ApiError } from '@trustsystem/errors';
import type { SecurityEventEmitter } from '@trustsystem/security-events';
import {
  actorHasPermission,
  alreadyClaimed,
  alreadyCompleted,
  crossTenant,
  staleVersion,
  TERMINAL_TASK_STATUSES,
  WORKFLOW_PERMISSIONS,
  type WorkflowActor,
  type WorkflowPriority,
  type WorkflowTaskRecord,
  type WorkflowTaskStatus,
} from '@trustsystem/workflow-core';
import { isEligibleForTask } from './assignment';

/**
 * Task lifecycle, and the concurrency that makes a shared queue work.
 *
 * The hard part of this file is one sentence: **two users must not both succeed at
 * claiming the same task.** Everything else is bookkeeping.
 *
 * The naive implementation reads the task, sees `claimedById` is null, and writes.
 * Two requests interleaving between the read and the write both see null and both
 * write, and the second silently overwrites the first — so two people work the same
 * item, and one of them finds their decision has vanished.
 *
 * The fix is a **conditional update**: the write carries the version the reader saw,
 * and the database applies it only if the row still has that version. One of the two
 * requests updates zero rows, and zero rows is the signal that somebody else won.
 * `TaskStore.claim` returns null in that case; this service turns it into a 409.
 *
 * That is why `claim` is a store method rather than a read plus a write here. A
 * check-then-act split across two calls cannot be made safe by anything this layer
 * does, so the atomicity has to live where the row does.
 */

export interface TaskListQuery {
  organizationId: string;
  status?: WorkflowTaskStatus[];
  workflowInstanceId?: string;
  assigneeUserId?: string;
  /** Pooled tasks the actor is eligible for. Mutually exclusive with `assigneeUserId`. */
  eligibleFor?: { roles: string[]; groupIds: string[]; userId: string };
  /** Tasks due before this. For an overdue queue. */
  dueBefore?: Date;
  priority?: WorkflowPriority[];
  page: number;
  pageSize: number;
}

export interface TaskPage {
  items: WorkflowTaskRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Task persistence.
 *
 * Every mutating method takes the version the caller read and returns `null` when
 * the row has moved on. That shape is what makes optimistic locking usable: the
 * caller cannot forget to pass the version, because it is a required parameter.
 */
export interface TaskStore {
  findById(id: string, organizationId: string): Promise<WorkflowTaskRecord | null>;
  list(query: TaskListQuery): Promise<TaskPage>;
  create(
    input: Omit<WorkflowTaskRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowTaskRecord>;

  /**
   * Claims a task, atomically.
   *
   * Must apply only when the row still has `expectedVersion` **and** `claimedById`
   * is still null. Returning null means somebody else got there first — not that
   * the task does not exist.
   */
  claim(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    claimedById: string;
    claimedAt: Date;
  }): Promise<WorkflowTaskRecord | null>;

  /** Conditional update. Returns null on a version mismatch. */
  update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<WorkflowTaskRecord>;
  }): Promise<WorkflowTaskRecord | null>;

  /** Cancels every open task for an instance. Used when a workflow ends. */
  cancelForInstance(input: {
    workflowInstanceId: string;
    organizationId: string;
    at: Date;
    reason: string;
  }): Promise<number>;

  /** Open tasks whose deadline has passed. For the expiry sweep. */
  listOverdue(input: {
    organizationId?: string;
    asOf: Date;
    limit: number;
  }): Promise<WorkflowTaskRecord[]>;

  /** Counts open tasks per assignee, for a least-loaded resolver and for metrics. */
  countOpenByAssignee(organizationId: string): Promise<Array<{ userId: string; count: number }>>;
}

/**
 * Where a task lifecycle record goes.
 *
 * A narrow callback rather than a dependency on `@trustsystem/workflow-history`, so this
 * package does not have to know how history is stored — and so the composition root
 * decides whether a record goes to history, to the audit trail, or to both. The
 * runtime wires it to both.
 *
 * Only *routine* lifecycle events go through here. The two operations that are
 * security signals — reassignment and a refused delegation — additionally emit to
 * `SecurityEventEmitter`, because they are how a decision gets steered to a
 * friendlier reviewer and they belong in a trail somebody reviews.
 */
export interface TaskEventRecorder {
  record(input: {
    type: 'task.claimed' | 'task.released' | 'task.reassigned' | 'task.completed' | 'task.expired';
    task: WorkflowTaskRecord;
    actorId: string | null;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export interface TaskServiceOptions {
  store: TaskStore;
  /** Routine lifecycle records: history and audit. */
  recorder?: TaskEventRecorder;
  /** Security signals only. See the note on `TaskEventRecorder`. */
  events?: SecurityEventEmitter;
  now?: () => Date;
}

export class TaskService {
  private readonly now: () => Date;

  constructor(private readonly options: TaskServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  // --- reads ---------------------------------------------------------------

  /**
   * One task, scoped to the actor's organization.
   *
   * The organization comes from the actor, never from a parameter, and a task in
   * another organization is `notFound` rather than `forbidden` — a 403 would confirm
   * the task exists.
   */
  async find(actor: WorkflowActor, id: string): Promise<WorkflowTaskRecord> {
    const task = await this.options.store.findById(id, actor.organizationId);
    if (!task) throw crossTenant();
    return task;
  }

  /**
   * Tasks assigned to or claimed by the actor.
   *
   * Paginated, and there is no unpaginated variant. A task list is the query most
   * likely to be called on every page load, and an organization with 50,000 open
   * tasks would return all of them to a UI that renders twenty.
   */
  listMine(actor: WorkflowActor, page: number, pageSize: number): Promise<TaskPage> {
    return this.options.store.list({
      organizationId: actor.organizationId,
      assigneeUserId: actor.userId,
      status: ['open', 'assigned', 'claimed', 'in_progress'],
      page,
      pageSize: clampPageSize(pageSize),
    });
  }

  /**
   * The pool: unclaimed tasks the actor is eligible for.
   *
   * Eligibility is computed in the query rather than by filtering in memory, because
   * filtering after the fact means reading every open task in the organization to
   * return the six the actor can see.
   */
  listAvailable(actor: WorkflowActor, page: number, pageSize: number): Promise<TaskPage> {
    return this.options.store.list({
      organizationId: actor.organizationId,
      status: ['open', 'assigned'],
      eligibleFor: {
        roles: actor.roles,
        groupIds: actor.groupIds,
        userId: actor.userId,
      },
      page,
      pageSize: clampPageSize(pageSize),
    });
  }

  /** Overdue tasks, for the administration portal. */
  listOverdue(actor: WorkflowActor, page: number, pageSize: number): Promise<TaskPage> {
    return this.options.store.list({
      organizationId: actor.organizationId,
      status: ['open', 'assigned', 'claimed', 'in_progress'],
      dueBefore: this.now(),
      page,
      pageSize: clampPageSize(pageSize),
    });
  }

  // --- claiming ------------------------------------------------------------

  /**
   * Claims a task from a pool.
   *
   * The read is for the *checks* — is this task claimable, is the actor eligible —
   * and the write is conditional on the version the read saw. Both are necessary:
   * without the read there is nothing to check against, and without the conditional
   * write the checks are advisory.
   */
  async claim(actor: WorkflowActor, taskId: string): Promise<WorkflowTaskRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.TASK_CLAIM.key)) {
      throw ApiError.forbidden('Claiming a task requires workflow.task.claim.');
    }

    const task = await this.find(actor, taskId);

    if (TERMINAL_TASK_STATUSES.includes(task.status)) {
      throw alreadyCompleted();
    }
    if (task.claimedById) {
      throw alreadyClaimed(task.claimedById);
    }

    const eligibility = isEligibleForTask(actor, task);
    if (!eligibility.eligible) {
      throw ApiError.forbidden('You are not eligible to claim this task.', {
        reason: 'not_assignee',
        eligibilityReason: eligibility.reason,
      });
    }

    const claimed = await this.options.store.claim({
      id: task.id,
      organizationId: actor.organizationId,
      expectedVersion: task.version,
      claimedById: actor.userId,
      claimedAt: this.now(),
    });

    if (!claimed) {
      /*
       * Zero rows updated. Somebody else claimed it between the read and the write,
       * which is exactly the race this method exists to lose safely.
       *
       * Re-read to name the claimant, because "already claimed" without a name is
       * how a shared queue turns into a message on a group chat. If the re-read finds
       * nothing — the task was cancelled in the same window — fall back to a plain
       * conflict rather than reporting a claimant that does not exist.
       */
      const current = await this.options.store.findById(task.id, actor.organizationId);
      if (current?.claimedById) throw alreadyClaimed(current.claimedById);
      if (current && TERMINAL_TASK_STATUSES.includes(current.status)) throw alreadyCompleted();
      throw staleVersion({ expected: task.version, actual: current?.version ?? -1 });
    }

    await this.options.recorder?.record({
      type: 'task.claimed',
      task: claimed,
      actorId: actor.userId,
      metadata: { eligibility: eligibility.reason },
    });

    return claimed;
  }

  /**
   * Releases a claim, returning the task to the pool.
   *
   * Only the claimant, or somebody with reassign authority. Without the second case a
   * task claimed by somebody who then goes on leave is stuck until their claim
   * expires — and nothing expires a claim.
   */
  async release(actor: WorkflowActor, taskId: string, reason: string): Promise<WorkflowTaskRecord> {
    const task = await this.find(actor, taskId);

    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw alreadyCompleted();
    if (!task.claimedById) return task; // Idempotent: already in the pool.

    const isClaimant = task.claimedById === actor.userId;
    const mayReassign = actorHasPermission(actor, WORKFLOW_PERMISSIONS.TASK_REASSIGN.key);

    if (!isClaimant && !mayReassign) {
      throw ApiError.forbidden(
        'Only the person holding this task, or somebody with workflow.task.reassign, can ' +
          'release it.',
        { reason: 'not_assignee' },
      );
    }

    const released = await this.applyUpdate(actor, task, {
      claimedById: null,
      claimedAt: null,
      status: task.assigneeUserId ? 'assigned' : 'open',
    });

    await this.options.recorder?.record({
      type: 'task.released',
      task: released,
      actorId: actor.userId,
      metadata: { previousHolder: task.claimedById, byClaimant: isClaimant, reason },
    });

    return released;
  }

  /**
   * Reassigns a task to somebody else.
   *
   * Always audited and always requires `workflow.task.reassign`, because taking work
   * away from one person and giving it to another is how an approval gets steered to
   * a friendlier reviewer. The audit record is the control; the permission only
   * limits who can try.
   */
  async reassign(
    actor: WorkflowActor,
    taskId: string,
    input: { toUserId: string | null; toRole: string | null; reason: string },
  ): Promise<WorkflowTaskRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.TASK_REASSIGN.key)) {
      throw ApiError.forbidden('Reassigning a task requires workflow.task.reassign.');
    }
    if (!input.toUserId && !input.toRole) {
      throw ApiError.validation(
        [{ path: 'toUserId', message: 'Provide a user or a role to reassign to.' }],
        'A reassignment needs a target.',
      );
    }
    if (!input.reason.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'A reassignment reason is required.' }],
        'Reassigning a task requires a reason.',
      );
    }

    const task = await this.find(actor, taskId);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw alreadyCompleted();

    const reassigned = await this.applyUpdate(actor, task, {
      assigneeUserId: input.toUserId,
      assigneeRole: input.toRole,
      assigneeGroupId: null,
      // The claim goes with the assignment. Leaving it would mean the new assignee
      // cannot act because the old holder still has it.
      claimedById: null,
      claimedAt: null,
      status: input.toUserId ? 'assigned' : 'open',
    });

    await this.options.recorder?.record({
      type: 'task.reassigned',
      task: reassigned,
      actorId: actor.userId,
      metadata: {
        fromUserId: task.assigneeUserId,
        fromRole: task.assigneeRole,
        toUserId: input.toUserId,
        toRole: input.toRole,
        reason: input.reason,
      },
    });

    // Also a security event: moving an approval task from one reviewer to another is
    // how a decision gets steered, so it belongs in a trail somebody reviews rather
    // than only in the workflow's own history.
    await this.options.events?.emit({
      type: 'workflow.task_reassigned',
      result: 'success',
      actorId: actor.userId,
      actorType: actor.actorType,
      organizationId: actor.organizationId,
      context: {
        taskId: task.id,
        workflowInstanceId: task.workflowInstanceId,
        stepKey: task.stepKey,
        fromUserId: task.assigneeUserId,
        toUserId: input.toUserId,
        toRole: input.toRole,
        reason: input.reason,
      },
    });

    return reassigned;
  }

  /**
   * Delegates a held task.
   *
   * Distinct from reassignment: the holder gives it away themselves, and
   * `delegatedById` records who did. That distinction matters to an auditor, because
   * "the approver handed this to a colleague" and "an administrator moved it" are
   * different facts about how a decision came to be made.
   *
   * The delegate must be eligible in their own right. Delegation moves work, not
   * authority — otherwise it would be a way to grant an approval permission to
   * somebody who does not hold it.
   */
  async delegate(
    actor: WorkflowActor,
    taskId: string,
    input: { toUserId: string; reason: string; isEligible: (userId: string) => Promise<boolean> },
  ): Promise<WorkflowTaskRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.TASK_DELEGATE.key)) {
      throw ApiError.forbidden('Delegating a task requires workflow.task.delegate.');
    }

    const task = await this.find(actor, taskId);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw alreadyCompleted();

    const holder = task.claimedById ?? task.assigneeUserId;
    if (holder !== actor.userId) {
      throw ApiError.forbidden('You can only delegate a task you hold.', {
        reason: 'not_assignee',
      });
    }

    if (input.toUserId === actor.userId) {
      throw ApiError.validation(
        [{ path: 'toUserId', message: 'Delegating to yourself changes nothing.' }],
        'Choose a different delegate.',
      );
    }

    const eligible = await input.isEligible(input.toUserId);
    if (!eligible) {
      // A refused delegation is an attempt to route an approval to somebody who
      // cannot make it, which is worth recording whether or not it was deliberate.
      await this.options.events?.emit({
        type: 'workflow.separation_of_duty_blocked',
        result: 'blocked',
        reason: 'delegate_not_independently_eligible',
        actorId: actor.userId,
        actorType: actor.actorType,
        organizationId: actor.organizationId,
        context: { taskId: task.id, stepKey: task.stepKey, attemptedDelegate: input.toUserId },
      });

      throw ApiError.forbidden(
        'That user is not eligible for this task. Delegation moves work, not authority.',
        { reason: 'separation_of_duty', rule: 'delegate_must_be_independently_eligible' },
      );
    }

    const delegated = await this.applyUpdate(actor, task, {
      assigneeUserId: input.toUserId,
      assigneeRole: null,
      assigneeGroupId: null,
      claimedById: input.toUserId,
      claimedAt: this.now(),
      delegatedById: actor.userId,
      delegatedAt: this.now(),
      status: 'claimed',
    });

    await this.options.recorder?.record({
      type: 'task.reassigned',
      task: delegated,
      actorId: actor.userId,
      metadata: { delegatedBy: actor.userId, toUserId: input.toUserId, reason: input.reason },
    });

    return delegated;
  }

  // --- completion ----------------------------------------------------------

  /**
   * Marks a task complete.
   *
   * Called by the runtime after a transition succeeds, not by a client directly —
   * which is why it takes an outcome rather than deciding one. A task completing
   * without the workflow moving is a task whose completion means nothing.
   */
  async complete(
    actor: WorkflowActor,
    taskId: string,
    input: { outcome: string; status?: Extract<WorkflowTaskStatus, 'completed' | 'rejected'> },
  ): Promise<WorkflowTaskRecord> {
    const task = await this.find(actor, taskId);

    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw alreadyCompleted();

    const eligibility = isEligibleForTask(actor, task);
    if (!eligibility.eligible) {
      throw ApiError.forbidden('You are not eligible to complete this task.', {
        reason: 'not_assignee',
        eligibilityReason: eligibility.reason,
      });
    }

    const completed = await this.applyUpdate(actor, task, {
      status: input.status ?? 'completed',
      completedById: actor.userId,
      completedAt: this.now(),
      outcome: input.outcome,
    });

    await this.options.recorder?.record({
      type: 'task.completed',
      task: completed,
      actorId: actor.userId,
      metadata: { outcome: input.outcome },
    });

    return completed;
  }

  /**
   * Expires overdue tasks.
   *
   * Run by a scheduler. Each task is expired independently and a version conflict is
   * *skipped rather than retried*: a conflict means somebody acted on the task in the
   * same moment, and their action is more current than the sweep's opinion that the
   * task is abandoned.
   */
  async expireOverdue(input: { organizationId?: string; limit?: number }): Promise<{
    expired: number;
    skipped: number;
  }> {
    const asOf = this.now();
    const candidates = await this.options.store.listOverdue({
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      asOf,
      limit: input.limit ?? 200,
    });

    let expired = 0;
    let skipped = 0;

    for (const task of candidates) {
      const updated = await this.options.store.update({
        id: task.id,
        organizationId: task.organizationId,
        expectedVersion: task.version,
        patch: { status: 'expired' },
      });
      if (updated) {
        expired += 1;
        await this.options.recorder?.record({
          type: 'task.expired',
          task: updated,
          // No actor: the sweep is the system, and attributing it to a person would
          // put somebody's name on a decision they did not make.
          actorId: null,
          metadata: { dueAt: task.dueAt?.toISOString() ?? null },
        });
      } else {
        skipped += 1;
      }
    }

    return { expired, skipped };
  }

  // --- internals -----------------------------------------------------------

  /**
   * A conditional update that turns a version mismatch into the right error.
   *
   * Re-reads on failure to distinguish the three cases a caller handles differently:
   * somebody claimed it, somebody completed it, or somebody changed something else.
   * Reporting a bare "stale version" for all three would tell a user to retry an
   * operation that will never succeed.
   */
  private async applyUpdate(
    actor: WorkflowActor,
    task: WorkflowTaskRecord,
    patch: Partial<WorkflowTaskRecord>,
  ): Promise<WorkflowTaskRecord> {
    const updated = await this.options.store.update({
      id: task.id,
      organizationId: actor.organizationId,
      expectedVersion: task.version,
      patch,
    });

    if (updated) return updated;

    const current = await this.options.store.findById(task.id, actor.organizationId);
    if (!current) throw crossTenant();
    if (TERMINAL_TASK_STATUSES.includes(current.status)) throw alreadyCompleted();
    if (current.claimedById && current.claimedById !== task.claimedById) {
      throw alreadyClaimed(current.claimedById);
    }
    throw staleVersion({ expected: task.version, actual: current.version });
  }
}

/**
 * Page size ceiling.
 *
 * A hard cap rather than a default, because a client asking for 10,000 tasks is
 * either a mistake or an attempt to make the database do the work of a denial of
 * service. 100 is the same ceiling the rest of the framework uses.
 */
export const MAX_PAGE_SIZE = 100;

function clampPageSize(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 25;
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}
