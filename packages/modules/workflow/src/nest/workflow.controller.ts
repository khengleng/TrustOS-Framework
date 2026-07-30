import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@trustos/auth';
import { RequirePermissions } from '@trustos/rbac';
import { OrganizationId } from '@trustos/tenancy';
import type { ActorContext, Paginated } from '@trustos/shared-types';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { approvalStepSchema } from '../definition';
import { INSTANCE_STATUSES } from '../store';
import type {
  WorkflowDefinitionRow,
  WorkflowHistoryRow,
  WorkflowInstanceRow,
  WorkflowTaskRow,
} from '../store';
import type { WorkflowService } from '../workflow.service';
import { WORKFLOW_SERVICE } from './tokens';

/**
 * Workflow endpoints.
 *
 * This is the one module controller that injects the actor. Everywhere else the
 * actor is audit metadata the framework resolves on its own, but here it is a
 * business input: who is approving decides whether the approval is allowed, and
 * the caller's permission set decides which tasks they can see and act on. Both
 * come from the access token via `@CurrentUser()`, never from the request body.
 */

const keySchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'Lowercase, dot, underscore or hyphen.');

const definitionSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(600).default(''),
  steps: z.array(approvalStepSchema).min(1).max(20),
});

const startSchema = z.object({
  definitionKey: keySchema,
  subjectType: z.string().trim().min(1).max(80),
  subjectId: z.string().trim().min(1).max(120),
});

const decisionSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
});

const listSchema = z.object({
  status: z.enum(INSTANCE_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@ApiTags('workflows')
@ApiBearerAuth('access-token')
@Controller('workflows')
export class WorkflowController {
  constructor(@Inject(WORKFLOW_SERVICE) private readonly workflows: WorkflowService) {}

  @Get('definitions')
  @RequirePermissions('workflow.definition.read')
  @ApiOperation({ summary: 'List workflow definitions.' })
  listDefinitions(): Promise<WorkflowDefinitionRow[]> {
    return this.workflows.listDefinitions();
  }

  @Post('definitions')
  @RequirePermissions('workflow.definition.manage')
  @ApiOperation({ summary: 'Register a workflow definition.' })
  registerDefinition(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(definitionSchema)) body: z.infer<typeof definitionSchema>,
  ): Promise<WorkflowDefinitionRow> {
    return this.workflows.registerDefinition(body, organizationId);
  }

  @Get('instances')
  @RequirePermissions('workflow.instance.read')
  @ApiOperation({ summary: 'List workflow instances.' })
  listInstances(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Paginated<WorkflowInstanceRow>> {
    return this.workflows.listInstances(organizationId, query);
  }

  @Post('instances')
  @RequirePermissions('workflow.instance.start')
  @ApiOperation({ summary: 'Start a workflow instance.' })
  start(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(startSchema)) body: z.infer<typeof startSchema>,
  ): Promise<{ instance: WorkflowInstanceRow; task: WorkflowTaskRow }> {
    // The submitter is the authenticated actor. Taking it from the body would let
    // a caller submit as somebody else and then approve it themselves.
    return this.workflows.start(body, organizationId, actor.userId);
  }

  @Get('tasks')
  @RequirePermissions('workflow.task.read')
  @ApiOperation({ summary: 'List tasks the caller can act on.' })
  tasks(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
  ): Promise<WorkflowTaskRow[]> {
    return this.workflows.tasksFor(actor.permissions, organizationId);
  }

  @Get('instances/:id')
  @RequirePermissions('workflow.instance.read')
  @ApiOperation({ summary: 'Read one workflow instance.' })
  findInstance(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<WorkflowInstanceRow> {
    return this.workflows.findInstance(id, organizationId);
  }

  @Get('instances/:id/history')
  @RequirePermissions('workflow.instance.read')
  @ApiOperation({ summary: 'Read the approval history of an instance.' })
  history(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<WorkflowHistoryRow[]> {
    return this.workflows.history(id, organizationId);
  }

  @Post('instances/:id/cancel')
  @RequirePermissions('workflow.instance.cancel')
  @ApiOperation({ summary: 'Cancel a running instance.' })
  cancel(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ): Promise<WorkflowInstanceRow> {
    return this.workflows.cancel(id, organizationId, actor.userId, body);
  }

  @Post('tasks/:id/approve')
  @RequirePermissions('workflow.task.act')
  @ApiOperation({ summary: 'Approve a task.' })
  approve(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ): Promise<{ task: WorkflowTaskRow; instance: WorkflowInstanceRow }> {
    return this.workflows.approve(id, organizationId, actor.userId, actor.permissions, body);
  }

  @Post('tasks/:id/reject')
  @RequirePermissions('workflow.task.act')
  @ApiOperation({ summary: 'Reject a task.' })
  reject(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(decisionSchema)) body: z.infer<typeof decisionSchema>,
  ): Promise<{ task: WorkflowTaskRow; instance: WorkflowInstanceRow }> {
    return this.workflows.reject(id, organizationId, actor.userId, actor.permissions, body);
  }
}
