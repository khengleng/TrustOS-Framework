import { ApiError } from '@trustos/errors';
import type {
  WorkflowActor,
  WorkflowInstanceRecord,
  WorkflowTaskRecord,
} from '@trustos/workflow-core';
import {
  approvalQueueQuerySchema,
  decisionNeedsReason,
  decisionRequestSchema,
  type ApprovalDetail,
  type ApprovalQueuePage,
  type ApprovalQueueRow,
  type DecisionRequest,
  type FeatureView,
} from './models';
import type {
  AuditPort,
  CommentPort,
  DecisionPort,
  EnginePort,
  ReassignmentPort,
  TaskQueryPort,
} from './ports';

export interface ApprovalWorkbenchOptions {
  tasks: TaskQueryPort;
  engine: EnginePort;
  decisions: DecisionPort;
  audit: AuditPort;
  /** Absent in a deployment that has not wired comments. Reported, never faked. */
  comments?: CommentPort;
  /** Absent in a deployment that has not wired reassignment. */
  reassignment?: ReassignmentPort;
  now?: () => Date;
}

/**
 * The Approval Workbench.
 *
 * An application, not a capability. It composes a queue, assembles a detail view and
 * submits decisions — and it enforces nothing itself, because everything it would
 * enforce is already enforced somewhere that cannot be bypassed by a second caller.
 *
 * The division is worth stating precisely, because "the UI checks it too" is how a
 * control ends up living only in the UI:
 *
 *   * **Tenant isolation** — every store call is passed `actor.organizationId`. No
 *     method here accepts an organization, so there is no input to tamper with.
 *   * **Eligibility** — `tasks.listAvailable` resolves it from roles and groups
 *     server-side. This class never reads a role name to decide what a person may do.
 *   * **Authorization, policy, maker-checker** — inside `engine.transition`. This class
 *     does not pre-check them and then submit; it submits, and reports the refusal.
 *   * **Decisions and audit** — written by the engine, read here.
 *
 * `eligibleActions` on the detail view looks like an exception and is not. It comes from
 * `engine.available`, which is the engine's own answer, and it decides which buttons to
 * draw — never whether an action is allowed. A button that is refused after being
 * pressed teaches somebody to press it; a button that is not drawn teaches them the rule.
 */
export class ApprovalWorkbenchService {
  private readonly now: () => Date;

  constructor(private readonly options: ApprovalWorkbenchOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The queue.
   *
   * Pooled tasks come from `listAvailable`, which already applies eligibility and the
   * tenant. Completed, rejected and returned are instance-scoped rather than task-scoped:
   * once a task is completed it stops being a queue entry, and what a reviewer wants to
   * see afterwards is the request and how it ended.
   */
  async queue(actor: WorkflowActor, rawQuery: unknown): Promise<ApprovalQueuePage> {
    assertTenanted(actor);
    const query = approvalQueueQuerySchema.parse(rawQuery ?? {});

    if (query.scope === 'available' || query.scope === 'mine') {
      const page =
        query.scope === 'mine'
          ? await this.options.tasks.listMine(actor, query.page, query.pageSize)
          : await this.options.tasks.listAvailable(actor, query.page, query.pageSize);

      const rows = await this.rowsForTasks(actor, page.items);

      return {
        rows: sortRows(filterRows(rows, query), query.sortBy, query.sortDirection),
        total: page.total,
        page: page.page,
        pageSize: page.pageSize,
        scope: query.scope,
      };
    }

    const states = TERMINAL_SCOPES[query.scope];
    const page = await this.options.engine.list(actor, {
      status: states.status,
      ...(states.currentState ? { currentState: states.currentState } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });

    const rows = page.items.map((instance) => this.rowFromInstance(instance, null));

    return {
      rows: sortRows(filterRows(rows, query), query.sortBy, query.sortDirection),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      scope: query.scope,
    };
  }

  /**
   * One request in full.
   *
   * `engine.find` is the authorization boundary. It is scoped, and a request belonging
   * to another tenant comes back as not found rather than forbidden — the framework's
   * existing convention, and the right one: "forbidden" confirms the record exists.
   */
  async detail(actor: WorkflowActor, instanceId: string): Promise<ApprovalDetail> {
    assertTenanted(actor);
    const instance = await this.options.engine.find(actor, instanceId);

    const [eligibleActions, decisions, audit] = await Promise.all([
      this.options.engine.available(actor, instance.id),
      this.options.decisions.listForInstance(instance.id, actor.organizationId),
      this.options.audit.query({
        organizationId: actor.organizationId,
        // The value `HistoryRecorder` actually writes. It was `workflow_instance` here,
        // which matches nothing, so the timeline rendered empty for every request — and
        // an empty timeline reads as "nothing happened" rather than "wrong query".
        entityType: AUDIT_ENTITY_TYPE,
        entityId: instance.id,
        page: 1,
        pageSize: 100,
      }),
    ]);

    const comments = await this.commentsFor(actor, instance.id);

    const ordered = [...decisions].sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
    const previous = ordered.length > 0 ? (ordered[ordered.length - 1]?.stepKey ?? null) : null;

    return {
      requestId: instance.businessObjectId,
      workflowInstanceId: instance.id,
      requestType: instance.businessObjectType,
      title: titleOf(instance),
      requestedBy: instance.initiatedById,
      organizationId: instance.organizationId,
      currentState: instance.currentState,
      previousState: previous,
      status: instance.status,
      priority: instance.priority,
      submittedAt: instance.startedAt,
      dueAt: instance.dueAt,
      version: instance.version,
      reworkCount: instance.reworkCount,
      workflowVersion: instance.workflowVersion,
      requestedChange: instance.data,
      eligibleActions,
      decisions: ordered.map((decision) => ({
        decisionId: decision.id,
        stepKey: decision.stepKey,
        actorId: decision.actorId,
        actorRole: decision.actorRole,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        explanation: decision.explanation,
        reworkCycle: decision.reworkCycle,
        decidedAt: decision.decidedAt,
        policyDecisionId: decision.policyDecisionId,
      })),
      auditTimeline: audit.items.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorId: entry.actorId ?? null,
        occurredAt: entry.createdAt,
      })),
      comments,
      // No document port is wired in this release. Saying so is the point.
      attachments: {
        available: false,
        reason: 'Evidence attachments are not configured for this deployment.',
      },
      taskId: null,
      correlation: {
        workflowInstanceId: instance.id,
        businessObjectId: instance.businessObjectId,
        requestId: null,
      },
    };
  }

  /**
   * Submit a decision.
   *
   * The whole method is a hand-off. It validates the shape of the submission, refuses a
   * rejection with no reason — which is a usability rule, and the engine enforces it too
   * — and then calls `transition`, carrying the version the reviewer's screen was built
   * at and the idempotency key their client generated.
   *
   * It deliberately does not pre-check eligibility, self-approval or permission. Asking
   * first and acting second is a race: the answer can change between the two calls, and
   * the code that trusts the first answer is the code that records the decision.
   */
  async decide(
    actor: WorkflowActor,
    instanceId: string,
    rawRequest: unknown,
    context: { taskId?: string | null; requestId?: string | null } = {},
  ): Promise<{
    instanceId: string;
    from: string;
    to: string;
    action: string;
    decisionId: string;
    version: number;
  }> {
    assertTenanted(actor);
    const request: DecisionRequest = decisionRequestSchema.parse(rawRequest ?? {});

    if (decisionNeedsReason(request.action) && !request.reasonCode?.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'reasonCode',
            message: 'A reason is required to reject or return a request.',
            code: 'reason_required',
          },
        ],
        'A reason is required to reject or return a request.',
      );
    }

    const result = await this.options.engine.transition(actor, {
      instanceId,
      action: request.action,
      expectedVersion: request.expectedVersion,
      reasonCode: request.reasonCode ?? null,
      explanation: request.explanation ?? null,
      taskId: context.taskId ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
      requestId: context.requestId ?? null,
    });

    return {
      instanceId: result.instance.id,
      from: result.from,
      to: result.to,
      action: result.action,
      decisionId: result.decisionId,
      version: result.instance.version,
    };
  }

  /** Reassignment, when the deployment wired it. Otherwise refused as unavailable. */
  async reassign(
    actor: WorkflowActor,
    taskId: string,
    input: { assigneeUserId: string; reason: string },
  ): Promise<WorkflowTaskRecord> {
    const port = this.options.reassignment;
    if (!port) {
      // `not_found` rather than a new error code: the capability does not exist on
      // this deployment, and the code list is a published contract.
      throw ApiError.notFound('Reassignment is not configured for this deployment.', {
        reason: 'reassignment_unavailable',
      });
    }

    if (!input.reason?.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'A reason is required.', code: 'reason_required' }],
        'A reason is required to reassign a task.',
      );
    }

    return port.reassign(actor, taskId, input);
  }

  /** Adds a comment, when the deployment wired comments. */
  async comment(
    actor: WorkflowActor,
    instanceId: string,
    body: string,
  ): Promise<Record<string, unknown>> {
    const port = this.options.comments;
    if (!port) {
      throw ApiError.notFound('Comments are not configured for this deployment.', {
        reason: 'comments_unavailable',
      });
    }

    // Scoped read first: it is the authorization boundary, and it refuses another
    // tenant's instance as not found before anything is written.
    await this.options.engine.find(actor, instanceId);

    if (!body?.trim()) {
      throw ApiError.validation(
        [{ path: 'body', message: 'A comment cannot be empty.', code: 'comment_empty' }],
        'A comment cannot be empty.',
      );
    }

    return port.add(actor, { workflowInstanceId: instanceId, body: body.trim() });
  }

  // --- internals ------------------------------------------------------------

  private async commentsFor(
    actor: WorkflowActor,
    instanceId: string,
  ): Promise<FeatureView<Array<Record<string, unknown>>>> {
    const port = this.options.comments;
    if (!port) {
      return {
        available: false,
        reason: 'Comments are not configured for this deployment.',
      };
    }

    const page = await port.list(actor, {
      workflowInstanceId: instanceId,
      page: 1,
      pageSize: 100,
    });

    return { available: true, items: page.items };
  }

  /**
   * Joins each task to the instance that produced it.
   *
   * Read one by one through the scoped `engine.find` rather than in a batch, because the
   * scoped read is the check. A task whose instance the actor cannot read is dropped
   * from the queue rather than rendered with the instance fields blank — a half-populated
   * row invites somebody to click it.
   */
  private async rowsForTasks(
    actor: WorkflowActor,
    tasks: readonly WorkflowTaskRecord[],
  ): Promise<ApprovalQueueRow[]> {
    const rows = await Promise.all(
      tasks.map(async (task) => {
        try {
          const instance = await this.options.engine.find(actor, task.workflowInstanceId);
          return this.rowFromInstance(instance, task);
        } catch {
          return null;
        }
      }),
    );

    return rows.filter((row): row is ApprovalQueueRow => row !== null);
  }

  private rowFromInstance(
    instance: WorkflowInstanceRecord,
    task: WorkflowTaskRecord | null,
  ): ApprovalQueueRow {
    const dueAt = task?.dueAt ?? instance.dueAt;

    return {
      taskId: task?.id ?? '',
      workflowInstanceId: instance.id,
      requestId: instance.businessObjectId,
      requestType: instance.businessObjectType,
      title: task?.title ?? titleOf(instance),
      requestedBy: instance.initiatedById,
      organizationId: instance.organizationId,
      submittedAt: instance.startedAt,
      currentState: instance.currentState,
      priority: task?.priority ?? instance.priority,
      dueAt,
      slaStatus: task?.slaStatus ?? null,
      slaBreached: task?.slaStatus === 'breached' || isOverdue(dueAt, this.now()),
      assignedToUserId: task?.assigneeUserId ?? null,
      assignedToRole: task?.assigneeRole ?? null,
      assignedToGroupId: task?.assigneeGroupId ?? null,
      version: instance.version,
    };
  }
}

/**
 * The entity type the workflow history recorder writes against a workflow instance.
 *
 * Named rather than inlined because it is a cross-package string constant: nothing in
 * the type system connects this read to that write, so the only protection is a test
 * that drives a real transition and reads the trail back.
 */
const AUDIT_ENTITY_TYPE = 'WorkflowInstance';

/** Which instance states each terminal queue means. */
const TERMINAL_SCOPES: Record<
  'completed' | 'rejected' | 'returned',
  { status?: string[]; currentState?: string[] }
> = {
  completed: { status: ['completed'] },
  rejected: { status: ['rejected'] },
  returned: { status: ['active'], currentState: ['draft', 'rework'] },
};

/**
 * Refuses an actor with no organization.
 *
 * `toWorkflowActor` already throws without one, so in the deployed path this cannot
 * happen — which is exactly why it is worth restating here. An actor assembled by some
 * future caller that skips that helper would otherwise reach the stores with an empty
 * tenant, and an empty tenant does not fail loudly: it matches nothing, and a queue that
 * is silently always empty is a bug nobody reports for a month.
 */
function assertTenanted(actor: WorkflowActor): void {
  if (!actor.organizationId?.trim()) {
    throw ApiError.forbidden('An approval action requires a tenant context.', {
      reason: 'organization_context_missing',
    });
  }
}

function titleOf(instance: WorkflowInstanceRecord): string {
  const candidate = instance.data?.['title'] ?? instance.data?.['subject'];
  return typeof candidate === 'string' && candidate.trim()
    ? candidate
    : `${instance.businessObjectType} ${instance.businessObjectId}`;
}

function isOverdue(dueAt: Date | null, now: Date): boolean {
  return dueAt !== null && dueAt.getTime() < now.getTime();
}

/**
 * Filtering and search, applied to the page that was read.
 *
 * Stated plainly because it matters for correctness: this narrows the current page, it
 * does not narrow the query. `total` therefore counts what the tenant-scoped store
 * matched, not what survived the filter. Pushing search into the store is the right
 * eventual answer; presenting a filtered count as a total would be a wrong answer now.
 */
function filterRows(
  rows: readonly ApprovalQueueRow[],
  query: {
    search?: string | undefined;
    requestType?: string | undefined;
    priority?: string | undefined;
    state?: string | undefined;
    breachedOnly?: boolean | undefined;
  },
): ApprovalQueueRow[] {
  const needle = query.search?.toLowerCase();

  return rows.filter((row) => {
    if (query.requestType && row.requestType !== query.requestType) return false;
    if (query.priority && row.priority !== query.priority) return false;
    if (query.state && row.currentState !== query.state) return false;
    if (query.breachedOnly && !row.slaBreached) return false;

    if (needle) {
      const haystack = `${row.title} ${row.requestType} ${row.requestedBy} ${row.requestId}`;
      if (!haystack.toLowerCase().includes(needle)) return false;
    }

    return true;
  });
}

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function sortRows(
  rows: ApprovalQueueRow[],
  sortBy: 'dueAt' | 'submittedAt' | 'priority' | 'title',
  direction: 'asc' | 'desc',
): ApprovalQueueRow[] {
  const factor = direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    switch (sortBy) {
      case 'priority':
        return ((PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)) * factor;
      case 'title':
        return a.title.localeCompare(b.title) * factor;
      case 'submittedAt':
        return (a.submittedAt.getTime() - b.submittedAt.getTime()) * factor;
      case 'dueAt':
      default: {
        // A row with no due date sorts last ascending, rather than sorting as epoch zero
        // and claiming to be the most urgent thing in the queue.
        if (a.dueAt === null && b.dueAt === null) return 0;
        if (a.dueAt === null) return 1;
        if (b.dueAt === null) return -1;
        return (a.dueAt.getTime() - b.dueAt.getTime()) * factor;
      }
    }
  });
}
