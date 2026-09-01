import { ApiError } from '@trustsystem/errors';
import type { Authorizer } from '@trustsystem/authorization';
import type { MetricsRecorder } from '@trustsystem/observability';
import type { SecurityEventEmitter } from '@trustsystem/security-events';
import {
  actorHasPermission,
  crossTenant,
  definitionNotPublished,
  reasonRequired,
  reworkLimitReached,
  staleVersion,
  WORKFLOW_PERMISSIONS,
  type WorkflowActor,
  type WorkflowDecisionOutcome,
  type WorkflowDecisionRecord,
  type WorkflowInstanceRecord,
  type WorkflowPriority,
  type WorkflowTaskRecord,
  type WorkflowVersionRecord,
} from '@trustsystem/workflow-core';
import {
  assertApproverEligible,
  decisionRequiresReason,
  evaluateApproval,
  type ApprovalProgress,
} from '@trustsystem/workflow-approvals';
import {
  assertDefinitionUntampered,
  type WorkflowApprovalSpec,
  type WorkflowDefinitionDocument,
} from '@trustsystem/workflow-definition';
import { HistoryRecorder } from '@trustsystem/workflow-history';
import { workflowResource, WORKFLOW_RESOURCE_TYPES } from '@trustsystem/workflow-policy';
import { SlaService } from '@trustsystem/workflow-sla';
import {
  resolveAssignment,
  TaskService,
  type AssignmentContext,
  type TaskStore,
} from '@trustsystem/workflow-tasks';
import {
  applyEditableFields,
  checkStepRequirements,
  CompiledWorkflow,
  CompiledWorkflowCache,
  followAutomaticChain,
  resolveTransition,
  availableActions,
} from './machine';
import { runIdempotent, type IdempotencyStore } from './idempotency';

/**
 * The workflow engine.
 *
 * Where the state machine, the approval models, the policy layer, tasks, SLAs and
 * history meet. Every externally triggered operation goes through the same six steps,
 * in this order, and the order is the security model:
 *
 *   1. **Load** the instance, scoped to the actor's organization. A record in another
 *      organization is not found, never forbidden.
 *   2. **Verify** the definition against its recorded hash. A definition modified
 *      outside the application is refused rather than executed.
 *   3. **Resolve** the transition against the state machine. Illegal actions stop here,
 *      before any authorization question is asked — a caller has no business learning
 *      whether they would be permitted to do something the workflow does not allow.
 *   4. **Authorize** through the policy engine, with the loaded record as the resource.
 *      Default deny.
 *   5. **Check** the step's own requirements: fields, evidence, approval progress.
 *   6. **Write**, conditionally on the version the load saw, then record history.
 *
 * Steps 3 and 4 in that order matter. Asking "may you approve?" before "is approval
 * available from here?" leaks the shape of the workflow to anybody who can enumerate
 * actions.
 */

export interface InstanceStore {
  findById(id: string, organizationId: string): Promise<WorkflowInstanceRecord | null>;
  create(
    input: Omit<WorkflowInstanceRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<WorkflowInstanceRecord>;

  /** Conditional update. Null on a version mismatch — the optimistic lock. */
  update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<WorkflowInstanceRecord>;
  }): Promise<WorkflowInstanceRecord | null>;

  list(query: {
    organizationId: string;
    status?: string[];
    workflowDefinitionId?: string;
    currentState?: string[];
    businessObjectType?: string;
    businessObjectId?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: WorkflowInstanceRecord[]; total: number; page: number; pageSize: number }>;

  /** Existing instance for a business object, for the "one at a time" guard. */
  findActiveForObject(input: {
    organizationId: string;
    businessObjectType: string;
    businessObjectId: string;
  }): Promise<WorkflowInstanceRecord | null>;
}

export interface DecisionStore {
  create(input: Omit<WorkflowDecisionRecord, 'id'>): Promise<WorkflowDecisionRecord>;
  /**
   * Decisions for one step and one rework cycle.
   *
   * The cycle filter is load-bearing, not an optimisation: after a return for rework
   * the maker may change the fields an approver looked at, so an approval from before
   * the rework is an approval of a different request.
   */
  listForStep(input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
    reworkCycle: number;
  }): Promise<WorkflowDecisionRecord[]>;
  listForInstance(
    workflowInstanceId: string,
    organizationId: string,
  ): Promise<WorkflowDecisionRecord[]>;
}

export interface VersionStore {
  findById(id: string): Promise<WorkflowVersionRecord | null>;
  /** The published version for a definition key, in this organization or global. */
  findPublished(input: {
    organizationId: string;
    definitionKey: string;
  }): Promise<WorkflowVersionRecord | null>;
}

/**
 * Confirms a business object exists and belongs to the same organization.
 *
 * The framework cannot know what a `Merchant` is, so an application registers a
 * validator per object type. Without one, `objectType` and `objectId` are just strings
 * and an instance could be started against a merchant in another organization — which
 * would put that merchant's id in this organization's history.
 *
 * A missing validator is a **refusal**, not a pass. See `startInstance`.
 */
export interface BusinessObjectValidator {
  readonly objectType: string;
  exists(input: { organizationId: string; objectId: string }): Promise<boolean>;
}

export interface WorkflowEngineOptions {
  instances: InstanceStore;
  versions: VersionStore;
  decisions: DecisionStore;
  tasks: TaskService;
  /**
   * The task store, alongside the service.
   *
   * Both, because they serve different callers. `TaskService` is the *actor-facing*
   * surface — it checks permissions and eligibility, which is right for a claim coming
   * from a person. The engine creates and cancels tasks as a consequence of a
   * transition that has already been authorized, so it writes through the store: asking
   * the service would mean re-authorizing the engine against itself, and the engine has
   * no actor for the task it is creating on somebody else's behalf.
   */
  taskStore: TaskStore;
  history: HistoryRecorder;
  authorizer: Authorizer;
  sla?: SlaService;
  idempotency?: IdempotencyStore;
  assignment?: AssignmentContext;
  events?: SecurityEventEmitter;
  metrics?: MetricsRecorder;
  objectValidators?: BusinessObjectValidator[];
  /**
   * Whether a step has live evidence attached.
   *
   * A callback rather than a dependency on `@trustsystem/workflow-history`, so the engine
   * runs in a deployment without the document module. Absent, it returns false — which
   * means a step requiring evidence cannot be satisfied, and that is the correct and
   * visible outcome rather than a requirement that silently passes.
   */
  hasAttachment?: (input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
  }) => Promise<boolean>;
  cache?: CompiledWorkflowCache;
  now?: () => Date;
  /**
   * Allows an instance to start with no validator for its object type.
   *
   * Defaults false. True is for a development environment where the business objects
   * do not exist yet; a production deployment that sets it has turned off the only
   * check that a workflow is about something real in its own organization.
   */
  allowUnvalidatedBusinessObjects?: boolean;
}

export interface StartInstanceInput {
  definitionKey: string;
  businessObjectType: string;
  businessObjectId: string;
  data?: Record<string, unknown>;
  priority?: WorkflowPriority;
  caseId?: string | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
}

export interface TransitionInput {
  instanceId: string;
  action: string;
  /** The version the caller read. Refused if the instance has moved on. */
  expectedVersion?: number;
  reasonCode?: string | null;
  explanation?: string | null;
  /** Edits to instance data. Filtered against the step's editable fields. */
  dataPatch?: Record<string, unknown>;
  /** The task this action completes, when there is one. */
  taskId?: string | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
}

export interface TransitionResult {
  instance: WorkflowInstanceRecord;
  from: string;
  to: string;
  action: string;
  decisionId: string;
  /** Approval progress on the step just left, when it had an approval block. */
  approval: ApprovalProgress | null;
  /** Tasks created on entering the new state. */
  tasksCreated: WorkflowTaskRecord[];
  /** Automatic transitions the engine followed afterwards. */
  automaticSteps: Array<{ action: string; to: string }>;
  /** Fields in the patch the step did not permit. Reported, never silently dropped. */
  rejectedFields: string[];
}

export class WorkflowEngine {
  private readonly now: () => Date;
  private readonly cache: CompiledWorkflowCache;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.cache = options.cache ?? new CompiledWorkflowCache();
  }

  // --- starting ------------------------------------------------------------

  /**
   * Starts an instance of the published version.
   *
   * "The published version" is resolved at start and pinned for the instance's whole
   * life. That is the versioning rule in one line: a definition published tomorrow does
   * not change the rules a request started under today.
   */
  async start(actor: WorkflowActor, input: StartInstanceInput): Promise<TransitionResult> {
    const execution = await runIdempotent({
      store: this.options.idempotency ?? noIdempotency(),
      organizationId: actor.organizationId,
      actorId: actor.userId,
      operation: 'workflow.start',
      idempotencyKey: input.idempotencyKey ?? null,
      payload: {
        definitionKey: input.definitionKey,
        businessObjectType: input.businessObjectType,
        businessObjectId: input.businessObjectId,
        data: input.data ?? {},
      },
      now: this.now,
      execute: async () => {
        const result = await this.startInternal(actor, input);
        return { result, reference: `workflow_instance:${result.instance.id}` };
      },
    });

    if (!execution.executed) {
      /*
       * A replay. The reference names the instance the first attempt created, and it is
       * re-read rather than reconstructed — the caller gets the *current* instance,
       * which is what they would have got had the first response arrived.
       */
      const instanceId = (execution.responseReference ?? '').split(':')[1];
      if (!instanceId) throw ApiError.conflict('This idempotency key has no recorded result.');

      const instance = await this.requireInstance(actor, instanceId);
      return {
        instance,
        from: '',
        to: instance.currentState,
        action: 'start',
        decisionId: 'replayed',
        approval: null,
        tasksCreated: [],
        automaticSteps: [],
        rejectedFields: [],
      };
    }

    return execution.result as TransitionResult;
  }

  private async startInternal(
    actor: WorkflowActor,
    input: StartInstanceInput,
  ): Promise<TransitionResult> {
    const started = this.now();

    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.INSTANCE_START.key)) {
      throw ApiError.forbidden('Starting a workflow requires workflow.instance.start.');
    }

    const version = await this.options.versions.findPublished({
      organizationId: actor.organizationId,
      definitionKey: input.definitionKey,
    });

    if (!version) {
      throw ApiError.notFound(
        `No published version of workflow "${input.definitionKey}" is available to this ` +
          'organization.',
      );
    }
    if (version.status !== 'published') throw definitionNotPublished(version.status);

    const workflow = this.compile(version);

    if (workflow.document.businessObjectType !== input.businessObjectType) {
      throw ApiError.validation(
        [
          {
            path: 'businessObjectType',
            message:
              `This workflow governs "${workflow.document.businessObjectType}", not ` +
              `"${input.businessObjectType}".`,
          },
        ],
        'The workflow and the business object do not match.',
      );
    }

    await this.assertBusinessObject(actor, input.businessObjectType, input.businessObjectId);

    const instance = await this.options.instances.create({
      organizationId: actor.organizationId,
      workflowDefinitionId: version.workflowDefinitionId,
      workflowVersionId: version.id,
      workflowVersion: version.version,
      status: 'active',
      currentState: workflow.initialState,
      businessObjectType: input.businessObjectType,
      businessObjectId: input.businessObjectId,
      data: input.data ?? {},
      priority: input.priority ?? workflow.document.defaultPriority,
      initiatedById: actor.userId,
      initiatedByActorType: actor.actorType,
      reworkCount: 0,
      startedAt: started,
      completedAt: null,
      cancelledAt: null,
      cancelledById: null,
      cancellationReason: null,
      dueAt: null,
      caseId: input.caseId ?? null,
    });

    await this.options.history.record({
      type: 'workflow.started',
      organizationId: actor.organizationId,
      workflowInstanceId: instance.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      toState: workflow.initialState,
      action: 'start',
      requestId: input.requestId ?? null,
      workflowDefinitionId: version.workflowDefinitionId,
      workflowVersion: version.version,
      metadata: {
        businessObjectType: input.businessObjectType,
        businessObjectId: input.businessObjectId,
        definitionKey: input.definitionKey,
      },
    });

    const tasksCreated = await this.enterState(actor, instance, workflow, workflow.initialState);

    // Workflow-level SLAs start with the instance, not with a step, so they measure
    // end-to-end duration through every rework cycle.
    if (this.options.sla && workflow.document.sla.length > 0) {
      await this.options.sla.startForStep({
        rules: workflow.document.sla,
        organizationId: actor.organizationId,
        workflowInstanceId: instance.id,
        workflowTaskId: null,
        stepKey: null,
      });
    }

    this.options.metrics?.increment('workflow.started', 1, {
      definition: workflow.id,
      version: workflow.version,
    });

    // Automatic transitions from the initial state, so a definition whose first state
    // routes immediately does not need a second request.
    const automatic = await this.runAutomaticChain(
      actor,
      instance,
      workflow,
      input.requestId ?? null,
    );

    return {
      instance: automatic.instance,
      from: '',
      to: automatic.instance.currentState,
      action: 'start',
      decisionId: 'start',
      approval: null,
      tasksCreated: [...tasksCreated, ...automatic.tasksCreated],
      automaticSteps: automatic.steps,
      rejectedFields: [],
    };
  }

  // --- transitions ---------------------------------------------------------

  /**
   * Executes a transition.
   *
   * The six steps from the header, in order. `expectedVersion` is optional but
   * strongly recommended: without it, a decision made against a page loaded ten
   * minutes ago is applied to whatever the instance is now.
   */
  async transition(actor: WorkflowActor, input: TransitionInput): Promise<TransitionResult> {
    const execution = await runIdempotent({
      store: this.options.idempotency ?? noIdempotency(),
      organizationId: actor.organizationId,
      actorId: actor.userId,
      operation: `workflow.transition.${input.action}`,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: {
        instanceId: input.instanceId,
        action: input.action,
        reasonCode: input.reasonCode ?? null,
        dataPatch: input.dataPatch ?? {},
      },
      now: this.now,
      execute: async () => {
        const result = await this.transitionInternal(actor, input);
        return { result, reference: `workflow_instance:${result.instance.id}` };
      },
    });

    if (!execution.executed) {
      const instance = await this.requireInstance(actor, input.instanceId);
      return {
        instance,
        from: instance.currentState,
        to: instance.currentState,
        action: input.action,
        decisionId: 'replayed',
        approval: null,
        tasksCreated: [],
        automaticSteps: [],
        rejectedFields: [],
      };
    }

    return execution.result as TransitionResult;
  }

  private async transitionInternal(
    actor: WorkflowActor,
    input: TransitionInput,
  ): Promise<TransitionResult> {
    const startedAt = Date.now();

    // 1. Load, scoped.
    const instance = await this.requireInstance(actor, input.instanceId);

    if (input.expectedVersion !== undefined && input.expectedVersion !== instance.version) {
      throw staleVersion({ expected: input.expectedVersion, actual: instance.version });
    }

    // 2. Verify the definition has not been modified.
    const version = await this.requireVersion(instance.workflowVersionId);
    const workflow = this.compile(version);

    // 3. Resolve against the state machine, before any authorization question.
    const resolved = resolveTransition({
      workflow,
      from: instance.currentState,
      action: input.action,
      data: instance.data,
    });

    const stepKey = instance.currentState;
    const decisions = await this.options.decisions.listForStep({
      organizationId: actor.organizationId,
      workflowInstanceId: instance.id,
      stepKey,
      reworkCycle: instance.reworkCount,
    });

    // 4. Authorize. Default deny, with the loaded record as the resource.
    const decision = await this.options.authorizer.assert({
      actor: toActorContext(actor),
      action: actionKeyFor(input.action, resolved.transition.permission),
      organizationId: actor.organizationId,
      resource: workflowResource({
        type: WORKFLOW_RESOURCE_TYPES.INSTANCE,
        id: instance.id,
        organizationId: instance.organizationId,
        attributes: {
          initiatedById: instance.initiatedById,
          currentState: instance.currentState,
          instanceStatus: instance.status,
          reworkCount: instance.reworkCount,
          decisions,
          allowSelfApproval: resolved.fromStep?.approval?.allowSelfApproval ?? false,
          actorGroupIds: actor.groupIds,
          transitionPermission: resolved.transition.permission ?? null,
        },
      }),
    });

    // 5. Step requirements, then approval.
    if (resolved.transition.requiresReason && !input.reasonCode?.trim()) {
      throw reasonRequired(input.action);
    }

    if (resolved.transition.isRework) {
      const limit = workflow.document.rework.maxCycles;
      if (limit !== null && instance.reworkCount >= limit) {
        // `onLimitReached` decides what happens next. `block` refuses; the others are
        // handled by the caller, which is why the limit is reported rather than
        // silently escalated here.
        if (workflow.document.rework.onLimitReached === 'block') throw reworkLimitReached(limit);
      }
    }

    const patched = applyEditableFields({
      step: resolved.fromStep,
      current: instance.data,
      patch: input.dataPatch ?? {},
    });

    const missing = checkStepRequirements({
      step: resolved.fromStep,
      data: patched.data,
      hasAttachment: await this.hasAttachment(instance, stepKey),
    });

    if (missing.length > 0) {
      throw ApiError.validation(
        missing.map((requirement) => ({
          path: requirement.field ?? 'attachments',
          message: requirement.detail,
          code: requirement.kind === 'attachment' ? 'attachment_required' : 'field_required',
        })),
        `Step "${stepKey}" is not complete.`,
      );
    }

    let approval: ApprovalProgress | null = null;

    if (resolved.fromStep?.approval) {
      approval = await this.recordDecision({
        actor,
        instance,
        stepKey,
        approvalSpec: resolved.fromStep.approval,
        transition: resolved.transition,
        decisions,
        decisionId: decision.decisionId,
        reasonCode: input.reasonCode ?? null,
        explanation: input.explanation ?? null,
        taskId: input.taskId ?? null,
        data: patched.data,
      });

      /*
       * An approval that is not yet satisfied does not advance the workflow.
       *
       * "2 of 3" means the first approver's decision is recorded and the instance stays
       * where it is. Advancing on the first would make every threshold a single
       * approval, which is the bug that makes a threshold look like it works.
       */
      if (!approval.satisfied && !approval.rejected && !approval.returned) {
        const updated = await this.applyPatch(actor, instance, {
          data: patched.data,
        });

        await this.options.history.record({
          type: 'approval.approved',
          organizationId: actor.organizationId,
          workflowInstanceId: instance.id,
          actorId: actor.userId,
          actorType: actor.actorType,
          fromState: stepKey,
          action: input.action,
          policyDecisionId: decision.decisionId,
          requestId: input.requestId ?? null,
          workflowDefinitionId: instance.workflowDefinitionId,
          workflowVersion: instance.workflowVersion,
          metadata: {
            approvals: approval.approvals,
            required: approval.required,
            outstanding: approval.outstanding.map((entry) => entry.key),
            stepKey,
          },
        });

        if (input.taskId) {
          await this.options.tasks.complete(actor, input.taskId, { outcome: input.action });
        }

        this.options.metrics?.observe('workflow.transition.duration_ms', Date.now() - startedAt, {
          definition: workflow.id,
          action: input.action,
          outcome: 'partial_approval',
        });

        return {
          instance: updated,
          from: stepKey,
          to: stepKey,
          action: input.action,
          decisionId: decision.decisionId,
          approval,
          tasksCreated: [],
          automaticSteps: [],
          rejectedFields: patched.rejected,
        };
      }
    }

    // 6. Write, conditionally, then record.
    const terminalStatus = resolved.transition.isCancellation
      ? 'cancelled'
      : resolved.transition.isRejection
        ? 'rejected'
        : resolved.completesWorkflow
          ? 'completed'
          : 'active';

    const updated = await this.applyPatch(actor, instance, {
      currentState: resolved.to,
      data: patched.data,
      status: terminalStatus,
      ...(resolved.transition.isRework ? { reworkCount: instance.reworkCount + 1 } : {}),
      ...(terminalStatus === 'completed' ? { completedAt: this.now() } : {}),
      ...(terminalStatus === 'cancelled'
        ? {
            cancelledAt: this.now(),
            cancelledById: actor.userId,
            cancellationReason: input.reasonCode ?? null,
          }
        : {}),
    });

    await this.options.history.record({
      type: resolved.transition.isRework
        ? 'workflow.returned_for_rework'
        : resolved.transition.isCancellation
          ? 'workflow.cancelled'
          : resolved.completesWorkflow
            ? 'workflow.completed'
            : 'workflow.transitioned',
      organizationId: actor.organizationId,
      workflowInstanceId: instance.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      fromState: stepKey,
      toState: resolved.to,
      action: input.action,
      policyDecisionId: decision.decisionId,
      requestId: input.requestId ?? null,
      workflowDefinitionId: instance.workflowDefinitionId,
      workflowVersion: instance.workflowVersion,
      metadata: {
        reasonCode: input.reasonCode ?? null,
        reworkCycle: instance.reworkCount,
        editedFields: patched.applied,
        rejectedFields: patched.rejected,
      },
    });

    if (input.taskId) {
      await this.options.tasks.complete(actor, input.taskId, {
        outcome: input.action,
        ...(resolved.transition.isRejection ? { status: 'rejected' as const } : {}),
      });
    }

    // Every other open task on the instance is cancelled when the workflow leaves the
    // state. A parallel approval that somebody else was holding must not stay in their
    // queue after a rejection settled it.
    await this.options.taskStore.cancelForInstance({
      workflowInstanceId: instance.id,
      organizationId: actor.organizationId,
      at: this.now(),
      reason: `state_changed_to_${resolved.to}`,
    });

    if (this.options.sla) {
      await this.options.sla.completeForInstance(instance.id, actor.organizationId).catch(() => 0);
    }

    const tasksCreated =
      terminalStatus === 'active'
        ? await this.enterState(actor, updated, workflow, resolved.to)
        : [];

    this.options.metrics?.increment(
      resolved.completesWorkflow
        ? 'workflow.completed'
        : resolved.transition.isRejection
          ? 'workflow.rejected'
          : 'workflow.transitioned',
      1,
      { definition: workflow.id, action: input.action },
    );
    this.options.metrics?.observe('workflow.transition.duration_ms', Date.now() - startedAt, {
      definition: workflow.id,
      action: input.action,
      outcome: terminalStatus,
    });

    const automatic =
      terminalStatus === 'active'
        ? await this.runAutomaticChain(actor, updated, workflow, input.requestId ?? null)
        : { instance: updated, tasksCreated: [], steps: [] };

    return {
      instance: automatic.instance,
      from: stepKey,
      to: automatic.instance.currentState,
      action: input.action,
      decisionId: decision.decisionId,
      approval,
      tasksCreated: [...tasksCreated, ...automatic.tasksCreated],
      automaticSteps: automatic.steps,
      rejectedFields: patched.rejected,
    };
  }

  // --- reads ---------------------------------------------------------------

  async find(actor: WorkflowActor, instanceId: string): Promise<WorkflowInstanceRecord> {
    return this.requireInstance(actor, instanceId);
  }

  /** The actions available to *anyone* from the current state, for a portal. */
  async available(actor: WorkflowActor, instanceId: string): Promise<string[]> {
    const instance = await this.requireInstance(actor, instanceId);
    const version = await this.requireVersion(instance.workflowVersionId);
    return availableActions({
      workflow: this.compile(version),
      from: instance.currentState,
      data: instance.data,
    });
  }

  /** Approval progress on the current step. */
  async approvalProgress(
    actor: WorkflowActor,
    instanceId: string,
  ): Promise<ApprovalProgress | null> {
    const instance = await this.requireInstance(actor, instanceId);
    const version = await this.requireVersion(instance.workflowVersionId);
    const workflow = this.compile(version);
    const step = workflow.step(instance.currentState);
    if (!step?.approval) return null;

    const decisions = await this.options.decisions.listForStep({
      organizationId: actor.organizationId,
      workflowInstanceId: instance.id,
      stepKey: instance.currentState,
      reworkCycle: instance.reworkCount,
    });

    return evaluateApproval({ approval: step.approval, decisions, data: instance.data });
  }

  list(
    actor: WorkflowActor,
    query: { status?: string[]; state?: string[]; page?: number; pageSize?: number },
  ): Promise<{ items: WorkflowInstanceRecord[]; total: number; page: number; pageSize: number }> {
    return this.options.instances.list({
      organizationId: actor.organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.state ? { currentState: query.state } : {}),
      page: query.page ?? 1,
      pageSize: Math.min(Math.max(query.pageSize ?? 25, 1), 100),
    });
  }

  // --- internals -----------------------------------------------------------

  private compile(version: WorkflowVersionRecord): CompiledWorkflow {
    const cached = this.cache.get(version.id);
    if (cached) return cached;

    /*
     * The tamper check.
     *
     * A published version's hash is recorded at publication and verified here, every
     * time a version is compiled. The application has write access to its own database,
     * so "the API refuses to change it" is not sufficient — a direct `UPDATE` would
     * otherwise change the rules a decision is made under, silently and retroactively.
     */
    if (version.status === 'published' || version.status === 'retired') {
      assertDefinitionUntampered({
        definition: version.definition,
        expectedHash: version.definitionHash,
        version: version.version,
      });
    }

    const compiled = new CompiledWorkflow(version.definition as WorkflowDefinitionDocument);
    // Only published versions are cached. A draft is edited, so caching it would serve
    // a stale definition to the next request.
    if (version.status === 'published' || version.status === 'retired') {
      this.cache.set(version.id, compiled);
    }
    return compiled;
  }

  private async requireInstance(actor: WorkflowActor, id: string): Promise<WorkflowInstanceRecord> {
    const instance = await this.options.instances.findById(id, actor.organizationId);
    // Not found, never forbidden: a 403 would confirm the instance exists in another
    // organization.
    if (!instance) throw crossTenant();
    return instance;
  }

  private async requireVersion(id: string): Promise<WorkflowVersionRecord> {
    const version = await this.options.versions.findById(id);
    if (!version) {
      throw ApiError.internal(
        `Workflow version ${id} is missing, but an instance references it. A published version ` +
          'must never be deleted — an instance reads its rules from it.',
      );
    }
    return version;
  }

  /**
   * Applies a conditional update, or reports the conflict.
   *
   * The optimistic lock. A null return means somebody changed the instance between the
   * load and the write, and the correct response is 409 rather than retrying — the
   * caller's decision was made against a state that no longer exists.
   */
  private async applyPatch(
    actor: WorkflowActor,
    instance: WorkflowInstanceRecord,
    patch: Partial<WorkflowInstanceRecord>,
  ): Promise<WorkflowInstanceRecord> {
    const updated = await this.options.instances.update({
      id: instance.id,
      organizationId: actor.organizationId,
      expectedVersion: instance.version,
      patch,
    });

    if (updated) return updated;

    const current = await this.options.instances.findById(instance.id, actor.organizationId);
    throw staleVersion({ expected: instance.version, actual: current?.version ?? -1 });
  }

  /**
   * Records one approver's decision and recomputes progress.
   *
   * Eligibility is checked here as well as in the policy layer, and the duplication is
   * deliberate: the policy layer is the enforcement point for every route, and this is
   * the point where the approver *slot* is resolved. `assertApproverEligible` returns
   * which slot the actor filled, which the policy engine has no way to report.
   */
  private async recordDecision(input: {
    actor: WorkflowActor;
    instance: WorkflowInstanceRecord;
    stepKey: string;
    approvalSpec: WorkflowApprovalSpec;
    transition: { isRejection: boolean; isRework: boolean };
    decisions: WorkflowDecisionRecord[];
    decisionId: string;
    reasonCode: string | null;
    explanation: string | null;
    taskId: string | null;
    data: Record<string, unknown>;
  }): Promise<ApprovalProgress> {
    const outcome: WorkflowDecisionOutcome = input.transition.isRejection
      ? 'reject'
      : input.transition.isRework
        ? 'return_for_rework'
        : 'approve';

    if (decisionRequiresReason(outcome) && !input.reasonCode?.trim()) {
      throw reasonRequired(outcome);
    }

    const approverKey =
      outcome === 'approve'
        ? assertApproverEligible({
            approval: input.approvalSpec,
            actor: input.actor,
            initiatedById: input.instance.initiatedById,
            decisions: input.decisions,
            data: input.data,
          })
        : null;

    await this.options.decisions.create({
      organizationId: input.actor.organizationId,
      workflowInstanceId: input.instance.id,
      workflowTaskId: input.taskId,
      stepKey: input.stepKey,
      approverKey,
      actorId: input.actor.userId,
      actorType: input.actor.actorType,
      actorRole: input.actor.roles[0] ?? null,
      decision: outcome,
      reasonCode: input.reasonCode,
      explanation: input.explanation,
      policyDecisionId: input.decisionId,
      reworkCycle: input.instance.reworkCount,
      decidedAt: this.now(),
    });

    const updated = await this.options.decisions.listForStep({
      organizationId: input.actor.organizationId,
      workflowInstanceId: input.instance.id,
      stepKey: input.stepKey,
      reworkCycle: input.instance.reworkCount,
    });

    return evaluateApproval({
      approval: input.approvalSpec,
      decisions: updated,
      data: input.data,
    });
  }

  /**
   * Creates the tasks and SLAs a state's step declares.
   *
   * A state with no step creates nothing, which is why `validateDefinition` warns about
   * a state without one: it is a state where no task exists, no SLA runs and nothing
   * prompts anybody.
   */
  private async enterState(
    actor: WorkflowActor,
    instance: WorkflowInstanceRecord,
    workflow: CompiledWorkflow,
    state: string,
  ): Promise<WorkflowTaskRecord[]> {
    const step = workflow.step(state);
    if (!step) return [];
    if (step.kind === 'terminal' || step.kind === 'automatic') return [];
    if (!step.assignment) return [];

    const target = await resolveAssignment(
      {
        assignment: step.assignment,
        organizationId: actor.organizationId,
        initiatedById: instance.initiatedById,
        data: instance.data,
        businessObjectType: instance.businessObjectType,
        businessObjectId: instance.businessObjectId,
        stepKey: state,
      },
      this.options.assignment ?? { directory: refusingDirectory() },
    );

    const dueAt =
      step.sla.length > 0
        ? new Date(this.now().getTime() + (step.sla[0]?.minutes ?? 0) * 60_000)
        : null;

    const task = await this.options.taskStore.create({
      organizationId: actor.organizationId,
      workflowInstanceId: instance.id,
      stepKey: state,
      title: step.name,
      description: step.description,
      status: target.userId ? 'assigned' : 'open',
      priority: instance.priority,
      assigneeUserId: target.userId,
      assigneeRole: target.role,
      assigneeGroupId: target.groupId,
      dueAt,
      slaStatus: step.sla.length > 0 ? 'active' : null,
      claimedById: null,
      claimedAt: null,
      completedById: null,
      completedAt: null,
      outcome: null,
      delegatedById: null,
      delegatedAt: null,
    });

    await this.options.history.record({
      type: 'task.created',
      organizationId: actor.organizationId,
      workflowInstanceId: instance.id,
      workflowTaskId: task.id,
      actorId: null,
      toState: state,
      workflowDefinitionId: instance.workflowDefinitionId,
      workflowVersion: instance.workflowVersion,
      metadata: {
        stepKey: state,
        strategy: target.strategy,
        rationale: target.rationale,
        assigneeUserId: target.userId,
        assigneeRole: target.role,
        assigneeGroupId: target.groupId,
      },
    });

    if (this.options.sla && step.sla.length > 0) {
      await this.options.sla.startForStep({
        rules: step.sla,
        organizationId: actor.organizationId,
        workflowInstanceId: instance.id,
        workflowTaskId: task.id,
        stepKey: state,
      });
    }

    this.options.metrics?.increment('workflow.task.created', 1, {
      definition: workflow.id,
      step: state,
    });

    return [task];
  }

  /**
   * Follows automatic transitions until the workflow settles.
   *
   * `followAutomaticChain` computes the whole chain first, so a definition with a cycle
   * fails before anything is written — rather than the engine writing three states and
   * then noticing. The chain is bounded and throws on overrun; a validated definition
   * cannot contain a cycle.
   */
  private async runAutomaticChain(
    actor: WorkflowActor,
    instance: WorkflowInstanceRecord,
    workflow: CompiledWorkflow,
    requestId: string | null,
  ): Promise<{
    instance: WorkflowInstanceRecord;
    tasksCreated: WorkflowTaskRecord[];
    steps: Array<{ action: string; to: string }>;
  }> {
    const chain = followAutomaticChain({
      workflow,
      from: instance.currentState,
      data: instance.data,
    });

    let current = instance;
    const tasksCreated: WorkflowTaskRecord[] = [];
    const steps: Array<{ action: string; to: string }> = [];

    for (const link of chain) {
      const isFinal = workflow.isFinal(link.to);

      current = await this.applyPatch(actor, current, {
        currentState: link.to,
        ...(isFinal ? { status: 'completed' as const, completedAt: this.now() } : {}),
      });

      await this.options.history.record({
        type: isFinal ? 'workflow.completed' : 'workflow.transitioned',
        organizationId: actor.organizationId,
        workflowInstanceId: current.id,
        // No actor: the engine took this, and putting somebody's name on it would
        // attribute a decision they did not make.
        actorId: null,
        actorType: 'system',
        fromState: link.transition.from,
        toState: link.to,
        action: link.transition.action,
        requestId,
        workflowDefinitionId: current.workflowDefinitionId,
        workflowVersion: current.workflowVersion,
        metadata: { automatic: true },
      });

      steps.push({ action: link.transition.action, to: link.to });

      if (!isFinal) {
        tasksCreated.push(...(await this.enterState(actor, current, workflow, link.to)));
      }
    }

    return { instance: current, tasksCreated, steps };
  }

  /**
   * Confirms the business object exists in this organization.
   *
   * A missing validator is a **refusal** by default. The alternative — accepting any
   * `objectType`/`objectId` pair — means an instance can be started against a merchant
   * in another organization, which puts that merchant's id into this organization's
   * history where it is visible to every participant.
   */
  private async assertBusinessObject(
    actor: WorkflowActor,
    objectType: string,
    objectId: string,
  ): Promise<void> {
    const validator = this.options.objectValidators?.find(
      (candidate) => candidate.objectType === objectType,
    );

    if (!validator) {
      if (this.options.allowUnvalidatedBusinessObjects) return;
      throw ApiError.internal(
        `No business-object validator is registered for "${objectType}". Register one, or set ` +
          'allowUnvalidatedBusinessObjects for a development environment — without a validator ' +
          'an instance could be started against another organization’s record.',
      );
    }

    const exists = await validator.exists({
      organizationId: actor.organizationId,
      objectId,
    });

    if (!exists) {
      // Not found rather than a validation error: the object either does not exist or
      // belongs to another organization, and the response must not distinguish the two.
      throw ApiError.notFound(`No ${objectType} with that id exists in this organization.`);
    }
  }

  /**
   * Whether the current step has evidence attached.
   *
   * Overridable so the engine does not depend on the attachment service directly —
   * a deployment without the document module still runs workflows, and a step that
   * requires evidence in that deployment simply cannot be satisfied, which is the
   * correct and visible outcome.
   */
  private async hasAttachment(instance: WorkflowInstanceRecord, stepKey: string): Promise<boolean> {
    if (!this.options.hasAttachment) return false;
    return this.options.hasAttachment({
      organizationId: instance.organizationId,
      workflowInstanceId: instance.id,
      stepKey,
    });
  }
}

/**
 * Converts a workflow actor back into the shape the policy engine expects.
 *
 * The two types exist for a reason — `WorkflowActor` deliberately omits the fields a
 * client must not supply — and this is the one place they meet.
 */
function toActorContext(actor: WorkflowActor): Parameters<Authorizer['assert']>[0]['actor'] {
  return {
    actorType: actor.actorType,
    userId: actor.userId,
    email: actor.email,
    organizationId: actor.organizationId,
    roles: actor.roles,
    permissions: actor.permissions,
    isSuperAdmin: actor.isSuperAdmin,
    tokenId: actor.tokenId,
    authentication: {
      mfa: actor.mfa,
      level: actor.authenticationLevel ?? 'low',
      methods: [],
      acr: null,
      authenticatedAt: null,
    },
  };
}

/**
 * The action key a policy sees.
 *
 * **The permission the definition declares**, or `workflow.instance.transition` when it
 * declares none. Not `workflow.instance.<action>`.
 *
 * That distinction was found by a test rather than reasoned out. The framework's standard
 * policy set ends with `rbac.permission`, which is the only policy that can *allow* — and
 * it allows by checking whether the actor holds the action key as a permission. An
 * invented key like `workflow.instance.escalate_to_compliance` is not a permission
 * anybody holds, so every transition whose action was not coincidentally also a
 * permission name was denied. The whole engine was unusable and the reason was one
 * function.
 *
 * Using the declared permission is also the correct semantics: the action being
 * authorized *is* what the definition says the actor must hold. A transition declaring
 * `workflow.approval.decide` is therefore authorized as an approval action, which is what
 * makes the self-approval and duplicate-approval policies apply to it — so a definition
 * decides which of its transitions are subject to maker-checker by choosing that
 * permission.
 */
function actionKeyFor(action: string, declaredPermission: string | null | undefined): string {
  if (declaredPermission) return declaredPermission;
  void action;
  return WORKFLOW_PERMISSIONS.INSTANCE_TRANSITION.key;
}

/** A no-op idempotency store, for callers that do not supply one. */
function noIdempotency(): IdempotencyStore {
  return {
    claim: async () => ({ claimed: true, existing: null }),
    complete: async () => undefined,
    fail: async () => undefined,
    find: async () => null,
    purgeExpired: async () => 0,
  };
}

/**
 * A member directory that refuses everything.
 *
 * The default, deliberately. An engine with no directory cannot resolve a role
 * assignment, and the honest outcome is a clear failure at the first instance rather
 * than a task assigned to nobody that silently never appears in a queue.
 */
function refusingDirectory(): AssignmentContext['directory'] {
  return {
    listByRole: async () => [],
    listByGroup: async () => [],
    isActiveMember: async () => false,
  };
}
