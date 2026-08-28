import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import type { ActorContext } from '@trustos/shared-types';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { toWorkflowActor, WORKFLOW_PERMISSIONS } from '@trustos/workflow-core';
import { describeEvent, type HistoryRecorder } from '@trustos/workflow-history';
import type { WorkflowEngine } from '@trustos/workflow-runtime';
import { RequirePermissions } from '@trustos/rbac';
import { HISTORY_RECORDER, WORKFLOW_ENGINE } from '../tokens';

/*
 * Request schemas.
 *
 * Declared above the controller rather than below it. A `const` referenced inside a
 * parameter decorator is evaluated when the class is defined, not when the method runs, so a
 * schema declared afterwards is a temporal dead zone error at class-definition time — which
 * TypeScript reports and which is easy to introduce by writing the routes first.
 */
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const listSchema = pageSchema.extend({
  status: z.string().max(200).optional(),
  state: z.string().max(400).optional(),
});

const startSchema = z.object({
  definitionKey: z.string().trim().min(2).max(80),
  businessObjectType: z.string().trim().min(1).max(120),
  businessObjectId: z.string().trim().min(1).max(64),
  /**
   * Instance data.
   *
   * A record of unknown, because the shape belongs to the product. It is what the
   * definition's conditions read, and it is never trusted for identity — `initiatedById`
   * comes from the verified actor and nothing here can override it.
   */
  data: z.record(z.unknown()).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  caseId: z.string().trim().min(1).max(64).optional(),
});

const transitionSchema = z.object({
  /** The version the caller read. Strongly recommended; see the controller header. */
  expectedVersion: z.number().int().min(0).optional(),
  reasonCode: z.string().trim().min(1).max(80).optional(),
  explanation: z.string().trim().max(2000).optional(),
  dataPatch: z.record(z.unknown()).optional(),
  taskId: z.string().trim().min(1).max(64).optional(),
});

const cancelSchema = z.object({
  reasonCode: z.string().trim().min(1).max(80),
  explanation: z.string().trim().max(2000).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

/**
 * Workflow instances: starting them, moving them, and reading their history.
 *
 * The transition route is the interesting one, and two of its inputs are worth explaining:
 *
 *   * `expectedVersion` is optional but strongly recommended. Without it, a decision made
 *     against a page loaded ten minutes ago is applied to whatever the instance is *now* —
 *     which for an approval means approving something other than what the approver read.
 *   * `Idempotency-Key` is a header rather than a body field, because it describes the
 *     request rather than the operation, and because a proxy retrying a request keeps
 *     headers.
 *
 * There is no route that sets a state directly. Every move goes through an action the
 * definition declares, so "client-supplied workflow state" is not a thing this API accepts.
 */
@ApiTags('workflow/instances')
@ApiBearerAuth('access-token')
@Controller('workflow/instances')
export class InstanceController {
  constructor(
    @Inject(WORKFLOW_ENGINE) private readonly engine: WorkflowEngine,
    @Inject(HISTORY_RECORDER) private readonly history: HistoryRecorder,
  ) {}

  @Get()
  @RequirePermissions(WORKFLOW_PERMISSIONS.INSTANCE_READ.key)
  @Authorize('workflow.instance.read', 'WorkflowInstance')
  @ApiOperation({ summary: 'List this organization’s workflow instances' })
  @ApiOkResponse({ description: 'Paginated. There is no unpaginated variant.' })
  list(
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ) {
    return this.engine.list(toWorkflowActor(actor), {
      ...(query.status ? { status: query.status.split(',') } : {}),
      ...(query.state ? { state: query.state.split(',') } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':instanceId')
  @RequirePermissions(WORKFLOW_PERMISSIONS.INSTANCE_READ.key)
  @Authorize('workflow.instance.read', 'WorkflowInstance')
  @ApiOperation({ summary: 'One instance, with the actions available from its current state' })
  @ApiOkResponse({
    description:
      'The available actions are computed from the definition and the instance data, so a ' +
      'portal never offers an action the runtime would refuse.',
  })
  async find(@CurrentUser() actor: ActorContext, @Param('instanceId') instanceId: string) {
    const workflowActor = toWorkflowActor(actor);

    const [instance, available, approval, recent] = await Promise.all([
      this.engine.find(workflowActor, instanceId),
      this.engine.available(workflowActor, instanceId),
      this.engine.approvalProgress(workflowActor, instanceId),
      // The last few events, not the whole trail. A summary view that loads 400 events to
      // render "last updated 20 minutes ago" is the query that makes a list page slow.
      this.history.recent({
        organizationId: workflowActor.organizationId,
        workflowInstanceId: instanceId,
        limit: 10,
      }),
    ]);

    return {
      instance,
      availableActions: available,
      approval,
      recentHistory: recent.map((event) => ({
        ...event,
        // Rendered as a sentence, because a table of `workflow.transitioned` rows is not
        // read.
        description: describeEvent(event),
      })),
    };
  }

  @Get(':instanceId/history')
  @RequirePermissions(WORKFLOW_PERMISSIONS.INSTANCE_READ.key)
  @Authorize('workflow.instance.read', 'WorkflowInstance')
  @ApiOperation({ summary: 'The complete history, paginated, newest first' })
  @ApiOkResponse({
    description:
      'Append-only, enforced by a database trigger. Nothing in this API can amend or delete ' +
      'an entry.',
  })
  async history_(
    @CurrentUser() actor: ActorContext,
    @Param('instanceId') instanceId: string,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    const workflowActor = toWorkflowActor(actor);
    // Scoped by the read: an instance in another organization is not found, so its history
    // cannot be reached by id.
    await this.engine.find(workflowActor, instanceId);

    const page = await this.history.query({
      organizationId: workflowActor.organizationId,
      workflowInstanceId: instanceId,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      ...page,
      items: page.items.map((event) => ({ ...event, description: describeEvent(event) })),
    };
  }

  @Post()
  @RequirePermissions(WORKFLOW_PERMISSIONS.INSTANCE_START.key)
  @Authorize('workflow.instance.start', 'WorkflowInstance')
  @ApiOperation({ summary: 'Start an instance of the published version' })
  @ApiOkResponse({
    description:
      'The version is resolved now and pinned for the instance’s whole life. A definition ' +
      'published tomorrow does not change the rules a request started under today.',
  })
  start(
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(startSchema)) body: z.infer<typeof startSchema>,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.engine.start(toWorkflowActor(actor), {
      definitionKey: body.definitionKey,
      businessObjectType: body.businessObjectType,
      businessObjectId: body.businessObjectId,
      ...(body.data ? { data: body.data } : {}),
      ...(body.priority ? { priority: body.priority } : {}),
      ...(body.caseId ? { caseId: body.caseId } : {}),
      idempotencyKey: idempotencyKey ?? null,
      requestId: requestId ?? null,
    });
  }

  @Post(':instanceId/actions/:action')
  @RequirePermissions(WORKFLOW_PERMISSIONS.INSTANCE_TRANSITION.key)
  @Authorize('workflow.instance.transition', 'WorkflowInstance')
  @ApiOperation({ summary: 'Execute a transition the definition permits' })
  @ApiOkResponse({
    description:
      'Returns the new state, approval progress, tasks created, automatic transitions ' +
      'followed, and any patch fields the step did not permit.',
  })
  transition(
    @CurrentUser() actor: ActorContext,
    @Param('instanceId') instanceId: string,
    @Param('action') action: string,
    @Body(new ZodValidationPipe(transitionSchema)) body: z.infer<typeof transitionSchema>,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.engine.transition(toWorkflowActor(actor), {
      instanceId,
      action,
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      ...(body.reasonCode ? { reasonCode: body.reasonCode } : {}),
      ...(body.explanation ? { explanation: body.explanation } : {}),
      ...(body.dataPatch ? { dataPatch: body.dataPatch } : {}),
      ...(body.taskId ? { taskId: body.taskId } : {}),
      idempotencyKey: idempotencyKey ?? null,
      requestId: requestId ?? null,
    });
  }

  @Post(':instanceId/cancel')
  @RequirePermissions(WORKFLOW_PERMISSIONS.INSTANCE_CANCEL.key)
  @Authorize('workflow.instance.cancel', 'WorkflowInstance')
  @ApiOperation({ summary: 'Cancel an instance' })
  @ApiOkResponse({
    description:
      'A distinct action from a rejection: cancelled means withdrawn, rejected means decided. ' +
      'The history is not erased either way.',
  })
  cancel(
    @CurrentUser() actor: ActorContext,
    @Param('instanceId') instanceId: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: z.infer<typeof cancelSchema>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.engine.transition(toWorkflowActor(actor), {
      instanceId,
      // `cancel` is an action the definition declares, like any other. There is no
      // back-door state write.
      action: 'cancel',
      reasonCode: body.reasonCode,
      ...(body.explanation ? { explanation: body.explanation } : {}),
      ...(body.expectedVersion !== undefined ? { expectedVersion: body.expectedVersion } : {}),
      idempotencyKey: idempotencyKey ?? null,
    });
  }
}
