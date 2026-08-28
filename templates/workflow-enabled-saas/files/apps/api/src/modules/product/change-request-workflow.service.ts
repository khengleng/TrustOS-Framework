import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '@trustos/errors';
import type { WorkflowActor } from '@trustos/workflow-core';
import type { WorkflowEngine } from '@trustos/workflow-runtime';
import { ChangeRequestService } from './change-request.service';
import { WORKFLOW_ENGINE } from '../../tokens';

/**
 * The bridge between a business object and its workflow.
 *
 * This is the file to read when wiring a workflow to your own domain, and there is one idea
 * in it worth taking: **ask the engine which action applies rather than telling it.**
 *
 * `approve` is the example. A low-risk request is approved by the `approve` action; a
 * high-risk one goes to `escalate_to_compliance` first. The controller does not know which,
 * and it must not — the risk threshold lives in the definition, so a controller that branched
 * on `riskRating === 'high'` would be a second copy of the routing rule that drifts from the
 * definition the moment somebody edits it.
 *
 * So `approve` asks `engine.available()` and picks whichever approval-shaped action the
 * definition offers.
 */
@Injectable()
export class ChangeRequestWorkflowService {
  constructor(
    private readonly requests: ChangeRequestService,
    @Inject(WORKFLOW_ENGINE) private readonly engine: WorkflowEngine,
  ) {}

  /** The definition key. Must match the `id` in `workflows/change-request-approval.json`. */
  private static readonly DEFINITION_KEY = 'change-request-approval';

  /**
   * Creates the request, then starts its workflow.
   *
   * In that order. If the start fails, the request exists in draft with no instance, which a
   * user can retry. The reverse would leave an instance pointing at a record that does not
   * exist, which nothing can clean up.
   */
  async createAndStart(
    actor: WorkflowActor,
    input: {
      title: string;
      description?: string;
      amount: number;
      riskRating: 'low' | 'medium' | 'high';
      justification?: string;
    },
    idempotencyKey: string | null,
  ) {
    const record = await this.requests.create({ ...input, createdById: actor.userId });

    const started = await this.engine.start(actor, {
      definitionKey: ChangeRequestWorkflowService.DEFINITION_KEY,
      businessObjectType: 'ChangeRequest',
      businessObjectId: record.id,
      // Only the fields the definition's conditions read.
      data: await this.requests.workflowData(record.id),
      // Derived from the request id when the caller supplied none, so a double-submit of the
      // *same* record cannot start two workflows.
      idempotencyKey: idempotencyKey ?? `change-request-start:${record.id}`,
    });

    await this.requests.linkWorkflow(record.id, started.instance.id);

    return {
      changeRequest: { ...record, workflowInstanceId: started.instance.id },
      workflow: {
        instanceId: started.instance.id,
        state: started.instance.currentState,
        version: started.instance.version,
        tasksCreated: started.tasksCreated.length,
      },
    };
  }

  /** The request, its workflow state, and what the caller could do next. */
  async describe(actor: WorkflowActor, id: string) {
    const record = await this.requests.find(id);

    if (!record.workflowInstanceId) {
      return { changeRequest: record, workflow: null };
    }

    const [instance, available, approval] = await Promise.all([
      this.engine.find(actor, record.workflowInstanceId),
      this.engine.available(actor, record.workflowInstanceId),
      this.engine.approvalProgress(actor, record.workflowInstanceId),
    ]);

    return {
      changeRequest: record,
      workflow: {
        instanceId: instance.id,
        state: instance.currentState,
        status: instance.status,
        version: instance.version,
        reworkCount: instance.reworkCount,
        // Computed by the engine from the definition and the data. A UI that derived this
        // itself would offer actions the engine refuses.
        availableActions: available,
        approval,
      },
    };
  }

  /** Executes a named action against the request's workflow. */
  async act(
    actor: WorkflowActor,
    id: string,
    action: string,
    input: { reasonCode?: string; explanation?: string; expectedVersion?: number },
    idempotencyKey: string | null,
  ) {
    const instanceId = await this.requireInstance(id);

    const result = await this.engine.transition(actor, {
      instanceId,
      action,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(input.explanation ? { explanation: input.explanation } : {}),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
      /*
       * The data patch carries the request's *current* values.
       *
       * A rework cycle lets the maker edit the amount and the risk rating, and the workflow's
       * conditions read those — so without this, a request returned as low-risk and edited to
       * high-risk would still route as low-risk. The engine filters the patch against the
       * step's editable fields, so nothing here can change what the step forbids.
       */
      dataPatch: await this.requests.workflowData(id),
      idempotencyKey,
    });

    return {
      state: result.to,
      previousState: result.from,
      status: result.instance.status,
      version: result.instance.version,
      approval: result.approval,
      automaticSteps: result.automaticSteps,
      // Reported rather than silently dropped, so a caller learns that an edit was refused.
      rejectedFields: result.rejectedFields,
    };
  }

  /**
   * Approves, picking whichever approval action the definition offers from here.
   *
   * The routing rule lives in the definition. Branching on `riskRating` here would be a
   * second copy of it, and the two would disagree the moment somebody changes the threshold.
   */
  async approve(
    actor: WorkflowActor,
    id: string,
    input: { reasonCode?: string; explanation?: string; expectedVersion?: number },
    idempotencyKey: string | null,
  ) {
    const instanceId = await this.requireInstance(id);
    const available = await this.engine.available(actor, instanceId);

    // In preference order. `escalate_to_compliance` first, because when both are somehow
    // offered the stricter path is the safe choice.
    const action = ['escalate_to_compliance', 'approve'].find((candidate) =>
      available.includes(candidate),
    );

    if (!action) {
      throw ApiError.conflict('No approval action is available from the current state.', {
        reason: 'illegal_transition',
        availableActions: available,
      });
    }

    return this.act(actor, id, action, input, idempotencyKey);
  }

  private async requireInstance(id: string): Promise<string> {
    const record = await this.requests.find(id);

    if (!record.workflowInstanceId) {
      throw ApiError.conflict(
        'This change request has no workflow instance. It was created before its workflow ' +
          'started, or the start failed — create it again.',
        { reason: 'instance_not_active' },
      );
    }

    return record.workflowInstanceId;
  }
}
