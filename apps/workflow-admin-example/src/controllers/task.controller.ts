import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { toWorkflowActor, WORKFLOW_PERMISSIONS } from '@trustos/workflow-core';
import { isEligibleForTask, type MemberDirectory, type TaskService } from '@trustos/workflow-tasks';
import { MEMBER_DIRECTORY, TASK_SERVICE } from '../tokens';

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

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const reassignSchema = z
  .object({
    toUserId: z.string().trim().min(1).max(64).optional(),
    toRole: z.string().trim().min(1).max(120).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((value) => Boolean(value.toUserId) !== Boolean(value.toRole), {
    message: 'Provide exactly one of toUserId or toRole.',
  });

const delegateSchema = z.object({
  toUserId: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(3).max(500),
});

/**
 * Task queues.
 *
 * Three lists, and the difference between them is the whole model:
 *
 *   * `mine` — assigned to me, or claimed by me. What a person works from.
 *   * `available` — the pool: unclaimed tasks I am eligible for. What a person picks from.
 *   * `overdue` — past due and still open. What a supervisor works from.
 *
 * All three are paginated with a hard ceiling, because a task list is the query most likely
 * to run on every page load and an organization with 50,000 open tasks would otherwise
 * return all of them to a UI that renders twenty.
 *
 * `claim` is the concurrency-critical route. Two users hitting it simultaneously produce one
 * winner and one 409 naming the claimant — see the header of `TaskService`.
 */
@ApiTags('workflow/tasks')
@ApiBearerAuth('access-token')
@Controller('workflow/tasks')
export class TaskController {
  constructor(
    @Inject(TASK_SERVICE) private readonly tasks: TaskService,
    @Inject(MEMBER_DIRECTORY) private readonly directory: MemberDirectory,
  ) {}

  @Get('mine')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_READ.key)
  @ApiOperation({ summary: 'Tasks assigned to or claimed by the signed-in user' })
  @ApiOkResponse({ description: 'Most urgent, closest to its deadline, first.' })
  mine(
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    // No permission beyond `task.read`: a person may always see their own queue, and the
    // user id comes from the verified actor rather than from a parameter.
    return this.tasks.listMine(toWorkflowActor(actor), query.page, query.pageSize);
  }

  @Get('available')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_READ.key)
  @ApiOperation({ summary: 'The pool: unclaimed tasks the user is eligible for' })
  @ApiOkResponse({
    description:
      'Eligibility is computed in the query, not by filtering afterwards — filtering after ' +
      'the fact means reading every open task to return the six the actor can see.',
  })
  available(
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    return this.tasks.listAvailable(toWorkflowActor(actor), query.page, query.pageSize);
  }

  @Get('overdue')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_READ.key)
  @Authorize('workflow.task.read', 'WorkflowTask')
  @ApiOperation({ summary: 'Tasks past their deadline and still open' })
  overdue(
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    return this.tasks.listOverdue(toWorkflowActor(actor), query.page, query.pageSize);
  }

  @Get(':taskId')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_READ.key)
  @Authorize('workflow.task.read', 'WorkflowTask')
  @ApiOperation({ summary: 'One task, with whether the caller may act on it' })
  @ApiOkResponse({
    description:
      'The eligibility verdict is returned so a portal can decide what to show without ' +
      'duplicating the rule — a portal’s copy of an authorization rule is a copy that drifts.',
  })
  async find(@CurrentUser() actor: ActorContext, @Param('taskId') taskId: string) {
    const workflowActor = toWorkflowActor(actor);
    const task = await this.tasks.find(workflowActor, taskId);

    return { task, eligibility: isEligibleForTask(workflowActor, task) };
  }

  @Post(':taskId/claim')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_CLAIM.key)
  @Authorize('workflow.task.claim', 'WorkflowTask')
  @ApiOperation({ summary: 'Claim a task from a pool' })
  @ApiOkResponse({
    description:
      'Concurrency-safe. Two simultaneous claimants produce one success and one 409 naming ' +
      'the claimant, because the write is conditional on the version the read saw.',
  })
  claim(@CurrentUser() actor: ActorContext, @Param('taskId') taskId: string) {
    return this.tasks.claim(toWorkflowActor(actor), taskId);
  }

  @Post(':taskId/release')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_CLAIM.key)
  @Authorize('workflow.task.claim', 'WorkflowTask')
  @ApiOperation({ summary: 'Return a claimed task to the pool' })
  @ApiOkResponse({
    description:
      'The claimant, or somebody with workflow.task.reassign — without the second case a task ' +
      'claimed by somebody who then goes on leave is stuck, because nothing expires a claim.',
  })
  release(
    @CurrentUser() actor: ActorContext,
    @Param('taskId') taskId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.tasks.release(toWorkflowActor(actor), taskId, body.reason);
  }

  @Post(':taskId/reassign')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_REASSIGN.key)
  @Authorize('workflow.task.reassign', 'WorkflowTask')
  @ApiOperation({ summary: 'Move a task to somebody else' })
  @ApiOkResponse({
    description:
      'Always audited and always emits a security event: moving an approval task from one ' +
      'reviewer to another is how a decision gets steered.',
  })
  reassign(
    @CurrentUser() actor: ActorContext,
    @Param('taskId') taskId: string,
    @Body(new ZodValidationPipe(reassignSchema)) body: z.infer<typeof reassignSchema>,
  ) {
    return this.tasks.reassign(toWorkflowActor(actor), taskId, {
      toUserId: body.toUserId ?? null,
      toRole: body.toRole ?? null,
      reason: body.reason,
    });
  }

  @Post(':taskId/delegate')
  @RequirePermissions(WORKFLOW_PERMISSIONS.TASK_DELEGATE.key)
  @Authorize('workflow.task.delegate', 'WorkflowTask')
  @ApiOperation({ summary: 'Hand a held task to another eligible user' })
  @ApiOkResponse({
    description:
      'Delegation moves work, not authority: the delegate must be eligible in their own right, ' +
      'otherwise this would be a way to grant an approval permission to somebody without it.',
  })
  async delegate(
    @CurrentUser() actor: ActorContext,
    @Param('taskId') taskId: string,
    @Body(new ZodValidationPipe(delegateSchema)) body: z.infer<typeof delegateSchema>,
  ) {
    const workflowActor = toWorkflowActor(actor);
    const task = await this.tasks.find(workflowActor, taskId);

    return this.tasks.delegate(workflowActor, taskId, {
      toUserId: body.toUserId,
      reason: body.reason,
      /*
       * Eligibility is checked against the *directory*, not against the request.
       *
       * The delegate must hold the task's role, or be its named assignee, in the same
       * organization. Trusting a claim in the body would make delegation the bypass.
       */
      isEligible: async (userId) => {
        if (!(await this.directory.isActiveMember(workflowActor.organizationId, userId))) {
          return false;
        }
        if (task.assigneeUserId) return task.assigneeUserId === userId;
        if (task.assigneeRole) {
          const holders = await this.directory.listByRole(
            workflowActor.organizationId,
            task.assigneeRole,
          );
          return holders.includes(userId);
        }
        if (task.assigneeGroupId) {
          const members = await this.directory.listByGroup(
            workflowActor.organizationId,
            task.assigneeGroupId,
          );
          return members.includes(userId);
        }
        // A task with no assignment has nobody eligible, so it cannot be delegated either.
        return false;
      },
    });
  }
}
