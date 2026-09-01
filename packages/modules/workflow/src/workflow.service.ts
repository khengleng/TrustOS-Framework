import { ApiError } from '@trustsystem/errors';
import type { ModuleContext } from '@trustsystem/module-sdk';
import { buildPageMeta, type Paginated } from '@trustsystem/shared-types';
import type { WorkflowConfig } from './config';
import {
  assertStepsWellFormed,
  stepAt,
  workflowDefinitionSchema,
  type ApprovalStep,
  type WorkflowDefinitionInput,
} from './definition';
import type { EscalationHook } from './escalation';
import {
  TERMINAL_INSTANCE_STATUSES,
  type InstanceStatus,
  type WorkflowDefinitionRow,
  type WorkflowHistoryRow,
  type WorkflowInstanceRow,
  type WorkflowStore,
  type WorkflowTaskRow,
} from './store';

/**
 * Approval workflows for one application.
 *
 * Three rules carry the weight, and each has a test named after it:
 *
 *   1. **Separation of duties.** A submitter cannot approve their own request
 *      unless the step says so explicitly, and an attempt is audited rather than
 *      silently refused — an attempted self-approval is exactly what a reviewer
 *      wants to know about.
 *   2. **One approver, one approval.** Required approvals are counted as
 *      *distinct actors*, taken from the append-only history. Counting decisions
 *      instead would let one person approve twice and satisfy a two-approver step.
 *   3. **Terminal is terminal.** An instance that has been approved, rejected or
 *      cancelled cannot be moved again, so every downstream count of approvals is
 *      stable.
 *
 * Task assignment is by permission, not by user id. `tasksFor` therefore takes
 * the caller's effective permissions — the set the framework's auth guard already
 * resolved — and never returns a task the caller could not act on.
 */

export interface StartInstanceInput {
  definitionKey: string;
  subjectType: string;
  subjectId: string;
}

export interface DecisionInput {
  comment?: string;
}

export const HISTORY_ACTIONS = {
  STARTED: 'started',
  TASK_ASSIGNED: 'task_assigned',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SELF_APPROVAL_BLOCKED: 'self_approval_blocked',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  SLA_BREACHED: 'sla_breached',
  ESCALATED: 'escalated',
} as const;

const MAX_PAGE_SIZE = 100;

export class WorkflowService {
  constructor(
    private readonly context: ModuleContext<WorkflowConfig>,
    private readonly store: WorkflowStore,
    private readonly escalation: EscalationHook,
  ) {}

  // --- definitions ----------------------------------------------------------

  listDefinitions(): Promise<WorkflowDefinitionRow[]> {
    return this.store.listDefinitions();
  }

  async registerDefinition(
    input: WorkflowDefinitionInput,
    organizationId: string,
  ): Promise<WorkflowDefinitionRow> {
    const parsed = workflowDefinitionSchema.parse(input);
    assertStepsWellFormed(parsed.steps);

    if (await this.store.findDefinition(parsed.key)) {
      // Definitions are not edited in place: a running instance holds a step
      // index into the definition it started with, and rewriting the steps
      // underneath it would change what an in-flight approval means. Register a
      // new key instead.
      throw ApiError.conflict(`A workflow definition with key "${parsed.key}" already exists.`, {
        reason: 'definition_immutable',
      });
    }

    const definition = await this.store.createDefinition({
      key: parsed.key,
      name: parsed.name,
      description: parsed.description,
      steps: parsed.steps,
    });

    await this.context.audit.record({
      action: 'workflow.definition.created',
      entityType: 'WorkflowDefinition',
      entityId: definition.id,
      organizationId,
      after: {
        key: definition.key,
        steps: parsed.steps.map((step) => ({
          order: step.order,
          approverPermission: step.approverPermission,
          requiredApprovals: step.requiredApprovals,
          allowSubmitterApproval: step.allowSubmitterApproval,
        })),
      },
    });

    return definition;
  }

  // --- instances ------------------------------------------------------------

  async start(
    input: StartInstanceInput,
    organizationId: string,
    submittedBy: string,
  ): Promise<{ instance: WorkflowInstanceRow; task: WorkflowTaskRow }> {
    const config = await this.context.resolveConfig(organizationId);
    const definition = await this.store.findDefinition(input.definitionKey);
    if (!definition) {
      throw ApiError.notFound(`No workflow definition with key "${input.definitionKey}".`);
    }

    const firstStep = stepAt(definition.steps, 1);
    if (!firstStep) throw ApiError.internal('Workflow definition has no first step.');

    const now = this.context.clock();
    const instance = await this.store.createInstance({
      definitionKey: definition.key,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      submittedBy,
      status: 'RUNNING',
      currentStep: 1,
      startedAt: now,
      completedAt: null,
    });

    const task = await this.assignTask(instance, firstStep, organizationId, config, now);

    await this.store.appendHistory({
      instanceId: instance.id,
      taskId: null,
      action: HISTORY_ACTIONS.STARTED,
      actorId: submittedBy,
      comment: null,
    });

    await this.context.audit.record({
      action: 'workflow.instance.started',
      entityType: 'WorkflowInstance',
      entityId: instance.id,
      organizationId,
      after: {
        definitionKey: definition.key,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        submittedBy,
      },
    });

    return { instance, task };
  }

  async listInstances(
    organizationId: string,
    query: { status?: InstanceStatus; page?: number; pageSize?: number } = {},
  ): Promise<Paginated<WorkflowInstanceRow>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 25)));

    const [items, totalItems] = await Promise.all([
      this.store.listInstances({
        ...(query.status ? { status: query.status } : {}),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.store.countInstances(query.status),
    ]);

    return { items, meta: buildPageMeta({ page, pageSize }, totalItems) };
  }

  findInstance(id: string, organizationId: string): Promise<WorkflowInstanceRow> {
    return this.store.findInstance(id, organizationId);
  }

  async history(instanceId: string, organizationId: string): Promise<WorkflowHistoryRow[]> {
    const instance = await this.store.findInstance(instanceId, organizationId);
    return this.store.listHistory(instance.id);
  }

  async cancel(
    instanceId: string,
    organizationId: string,
    actorId: string,
    input: DecisionInput = {},
  ): Promise<WorkflowInstanceRow> {
    const instance = await this.store.findInstance(instanceId, organizationId);
    this.assertRunning(instance);

    for (const task of await this.store.listTasks({ instanceId: instance.id, status: 'PENDING' })) {
      await this.store.updateTask(task.id, {
        status: 'CANCELLED',
        decidedAt: this.context.clock(),
      });
    }

    const cancelled = await this.store.updateInstance(instance.id, {
      status: 'CANCELLED',
      completedAt: this.context.clock(),
    });

    await this.store.appendHistory({
      instanceId: instance.id,
      taskId: null,
      action: HISTORY_ACTIONS.CANCELLED,
      actorId,
      comment: input.comment ?? null,
    });

    await this.context.audit.record({
      action: 'workflow.instance.cancelled',
      entityType: 'WorkflowInstance',
      entityId: instance.id,
      organizationId,
      before: { status: instance.status, currentStep: instance.currentStep },
      after: { status: 'CANCELLED' },
    });

    return cancelled;
  }

  // --- tasks ----------------------------------------------------------------

  /**
   * Tasks the caller could act on.
   *
   * Filtered by the caller's effective permissions rather than returned in full
   * and filtered in the UI: a task list that shows work someone cannot do is a
   * disclosure of what is in flight elsewhere in the organization.
   */
  async tasksFor(permissions: string[], organizationId: string): Promise<WorkflowTaskRow[]> {
    const held = new Set(permissions);
    const tasks = await this.store.listTasks({ status: 'PENDING' });

    // A wildcard holder — platform staff — sees everything, which is the same
    // rule the framework's permission checker applies.
    const all = held.has('*');
    const visible = tasks.filter((task) => all || held.has(task.approverPermission));

    // The store is tenant-scoped; this re-checks what it returned.
    return visible.filter((task) => task.organizationId === organizationId);
  }

  findTask(id: string, organizationId: string): Promise<WorkflowTaskRow> {
    return this.store.findTask(id, organizationId);
  }

  /**
   * Approves a task.
   *
   * `actorId` is a real business input here, not audit metadata: it decides
   * whether the approval is permitted at all.
   */
  async approve(
    taskId: string,
    organizationId: string,
    actorId: string,
    permissions: string[],
    input: DecisionInput = {},
  ): Promise<{ task: WorkflowTaskRow; instance: WorkflowInstanceRow }> {
    const config = await this.context.resolveConfig(organizationId);
    const task = await this.store.findTask(taskId, organizationId);
    const instance = await this.store.findInstance(task.instanceId, organizationId);

    this.assertRunning(instance);
    this.assertPending(task);
    this.assertHoldsPermission(task, permissions);
    await this.assertNotSelfApproval(task, instance, organizationId, actorId);
    await this.assertNotAlreadyApproved(task, actorId);

    await this.store.appendHistory({
      instanceId: instance.id,
      taskId: task.id,
      action: HISTORY_ACTIONS.APPROVED,
      actorId,
      comment: input.comment ?? null,
    });

    await this.context.audit.record({
      action: 'workflow.task.approved',
      entityType: 'WorkflowTask',
      entityId: task.id,
      organizationId,
      after: { stepOrder: task.stepOrder, stepName: task.stepName, actorId },
    });

    const approvals = await this.distinctApprovers(task.id);
    if (approvals < task.requiredApprovals) {
      // Still short of the required count: the task stays open for the next
      // approver, and the history already records this decision.
      return { task, instance };
    }

    const now = this.context.clock();
    const decided = await this.store.updateTask(task.id, { status: 'APPROVED', decidedAt: now });

    const definition = await this.store.findDefinition(instance.definitionKey);
    const nextStep = definition ? stepAt(definition.steps, task.stepOrder + 1) : undefined;

    if (nextStep) {
      const advanced = await this.store.updateInstance(instance.id, {
        currentStep: nextStep.order,
      });
      await this.assignTask(advanced, nextStep, organizationId, config, now);
      return { task: decided, instance: advanced };
    }

    const completed = await this.store.updateInstance(instance.id, {
      status: 'APPROVED',
      completedAt: now,
    });

    await this.store.appendHistory({
      instanceId: instance.id,
      taskId: null,
      action: HISTORY_ACTIONS.COMPLETED,
      actorId,
      comment: null,
    });

    await this.context.audit.record({
      action: 'workflow.instance.completed',
      entityType: 'WorkflowInstance',
      entityId: instance.id,
      organizationId,
      after: { status: 'APPROVED', steps: task.stepOrder },
    });

    return { task: decided, instance: completed };
  }

  /**
   * Rejects a task, which rejects the instance.
   *
   * A rejection is terminal rather than a return to a previous step: "send it
   * back for amendment" is a new submission, and modelling it as a loop would
   * make the approval history ambiguous about which version was approved.
   */
  async reject(
    taskId: string,
    organizationId: string,
    actorId: string,
    permissions: string[],
    input: DecisionInput = {},
  ): Promise<{ task: WorkflowTaskRow; instance: WorkflowInstanceRow }> {
    const task = await this.store.findTask(taskId, organizationId);
    const instance = await this.store.findInstance(task.instanceId, organizationId);

    this.assertRunning(instance);
    this.assertPending(task);
    this.assertHoldsPermission(task, permissions);
    // A submitter rejecting their own request is a withdrawal, and there is a
    // `cancel` for that; letting it through here would put a rejection in the
    // trail that reads as an independent decision.
    await this.assertNotSelfApproval(task, instance, organizationId, actorId);

    const now = this.context.clock();
    const decided = await this.store.updateTask(task.id, { status: 'REJECTED', decidedAt: now });
    const rejected = await this.store.updateInstance(instance.id, {
      status: 'REJECTED',
      completedAt: now,
    });

    await this.store.appendHistory({
      instanceId: instance.id,
      taskId: task.id,
      action: HISTORY_ACTIONS.REJECTED,
      actorId,
      comment: input.comment ?? null,
    });

    await this.context.audit.record({
      action: 'workflow.task.rejected',
      entityType: 'WorkflowTask',
      entityId: task.id,
      organizationId,
      after: { stepOrder: task.stepOrder, actorId, comment: input.comment ?? null },
    });

    return { task: decided, instance: rejected };
  }

  // --- SLA and escalation ---------------------------------------------------

  /** Pending tasks past their due time and not yet escalated. */
  async breachedTasks(organizationId: string): Promise<WorkflowTaskRow[]> {
    const now = this.context.clock();
    const tasks = await this.store.listTasks({ status: 'PENDING' });

    return tasks.filter(
      (task) =>
        task.organizationId === organizationId &&
        task.dueAt.getTime() <= now.getTime() &&
        task.escalatedAt === null,
    );
  }

  /**
   * Escalates breached tasks.
   *
   * Called by whatever the application uses as a scheduler; the module owns no
   * timer, for the reason given in the notification module.
   *
   * Each task escalates once. `escalatedAt` is set before the hook runs, so a
   * hook that throws does not cause the same task to be escalated on every pass —
   * a notification storm is a worse failure than a missed escalation, and the
   * missed one is visible in the audit trail.
   */
  async runEscalations(organizationId: string): Promise<{ escalated: number; failed: number }> {
    const config = await this.context.resolveConfig(organizationId);
    if (!config.escalationEnabled) return { escalated: 0, failed: 0 };

    const breached = await this.breachedTasks(organizationId);
    const now = this.context.clock();
    let escalated = 0;
    let failed = 0;

    for (const task of breached) {
      const instance = await this.store.findInstance(task.instanceId, organizationId);
      await this.store.updateTask(task.id, { escalatedAt: now });

      await this.store.appendHistory({
        instanceId: instance.id,
        taskId: task.id,
        action: HISTORY_ACTIONS.SLA_BREACHED,
        actorId: null,
        comment: null,
      });

      await this.context.audit.record({
        action: 'workflow.sla.breached',
        entityType: 'WorkflowTask',
        entityId: task.id,
        organizationId,
        after: {
          stepName: task.stepName,
          dueAt: task.dueAt.toISOString(),
          overdueMinutes: Math.floor((now.getTime() - task.dueAt.getTime()) / 60_000),
        },
      });

      try {
        await this.escalation.onBreach({
          task,
          instance,
          organizationId,
          overdueMinutes: Math.floor((now.getTime() - task.dueAt.getTime()) / 60_000),
        });
        escalated += 1;

        await this.store.appendHistory({
          instanceId: instance.id,
          taskId: task.id,
          action: HISTORY_ACTIONS.ESCALATED,
          actorId: null,
          comment: null,
        });

        await this.context.audit.record({
          action: 'workflow.task.escalated',
          entityType: 'WorkflowTask',
          entityId: task.id,
          organizationId,
          after: { hook: this.escalation.id },
        });
      } catch (error) {
        failed += 1;
        // Logged rather than thrown: one broken hook must not stop the rest of
        // the batch from escalating.
        this.context.logger.error(
          {
            moduleId: this.context.moduleId,
            taskId: task.id,
            hook: this.escalation.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'workflow escalation hook failed',
        );
      }
    }

    return { escalated, failed };
  }

  // --- internals ------------------------------------------------------------

  private async assignTask(
    instance: WorkflowInstanceRow,
    step: ApprovalStep,
    organizationId: string,
    config: WorkflowConfig,
    now: Date,
  ): Promise<WorkflowTaskRow> {
    const slaMinutes = step.slaMinutes ?? config.defaultSlaMinutes;

    const task = await this.store.createTask({
      instanceId: instance.id,
      stepOrder: step.order,
      stepName: step.name,
      approverPermission: step.approverPermission,
      requiredApprovals: step.requiredApprovals,
      status: 'PENDING',
      dueAt: new Date(now.getTime() + slaMinutes * 60_000),
      escalatedAt: null,
      decidedAt: null,
    });

    await this.store.appendHistory({
      instanceId: instance.id,
      taskId: task.id,
      action: HISTORY_ACTIONS.TASK_ASSIGNED,
      actorId: null,
      comment: null,
    });

    await this.context.audit.record({
      action: 'workflow.task.assigned',
      entityType: 'WorkflowTask',
      entityId: task.id,
      organizationId,
      after: {
        stepOrder: step.order,
        stepName: step.name,
        approverPermission: step.approverPermission,
        dueAt: task.dueAt.toISOString(),
      },
    });

    return task;
  }

  /** Distinct actors who have approved this task, from the append-only history. */
  private async distinctApprovers(taskId: string): Promise<number> {
    const entries = await this.store.listTaskHistory(taskId);
    const approvers = new Set(
      entries
        .filter((entry) => entry.action === HISTORY_ACTIONS.APPROVED && entry.actorId)
        .map((entry) => entry.actorId as string),
    );
    return approvers.size;
  }

  private assertRunning(instance: WorkflowInstanceRow): void {
    if (!TERMINAL_INSTANCE_STATUSES.includes(instance.status)) return;

    throw ApiError.conflict(`This workflow is ${instance.status} and cannot be changed.`, {
      reason: 'terminal_workflow_state',
      status: instance.status,
    });
  }

  private assertPending(task: WorkflowTaskRow): void {
    if (task.status === 'PENDING') return;

    throw ApiError.conflict(`This task is already ${task.status}.`, {
      reason: 'task_already_decided',
      status: task.status,
    });
  }

  private assertHoldsPermission(task: WorkflowTaskRow, permissions: string[]): void {
    if (permissions.includes('*') || permissions.includes(task.approverPermission)) return;

    // A second check on top of the route's own `@RequirePermissions`: the route
    // permission says "may act on tasks", while the step names the permission this
    // particular approval requires, and they are not the same statement.
    throw ApiError.forbidden('You do not hold the permission this approval step requires.', {
      reason: 'step_permission_missing',
      required: task.approverPermission,
    });
  }

  private async assertNotSelfApproval(
    task: WorkflowTaskRow,
    instance: WorkflowInstanceRow,
    organizationId: string,
    actorId: string,
  ): Promise<void> {
    if (instance.submittedBy !== actorId) return;

    const definition = await this.store.findDefinition(instance.definitionKey);
    const step = definition ? stepAt(definition.steps, task.stepOrder) : undefined;
    if (step?.allowSubmitterApproval) return;

    // Audited before refusing: an attempted self-approval is precisely what a
    // reviewer wants to see, and a silent 403 leaves no trace of the attempt.
    await this.store.appendHistory({
      instanceId: instance.id,
      taskId: task.id,
      action: HISTORY_ACTIONS.SELF_APPROVAL_BLOCKED,
      actorId,
      comment: null,
    });

    await this.context.audit.record({
      action: 'workflow.task.self-approval-blocked',
      entityType: 'WorkflowTask',
      entityId: task.id,
      organizationId,
      after: { stepOrder: task.stepOrder, actorId, submittedBy: instance.submittedBy },
    });

    throw ApiError.forbidden('The submitter of a request may not approve it.', {
      reason: 'self_approval_blocked',
      taskId: task.id,
    });
  }

  private async assertNotAlreadyApproved(task: WorkflowTaskRow, actorId: string): Promise<void> {
    const entries = await this.store.listTaskHistory(task.id);
    const already = entries.some(
      (entry) => entry.action === HISTORY_ACTIONS.APPROVED && entry.actorId === actorId,
    );
    if (!already) return;

    // Otherwise one person could satisfy a two-approver step by clicking twice.
    throw ApiError.conflict('You have already approved this task.', {
      reason: 'duplicate_approval',
      taskId: task.id,
    });
  }
}
