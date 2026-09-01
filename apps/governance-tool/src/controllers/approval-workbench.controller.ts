import { Body, Controller, Get, Inject, Optional, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { HumanActorsOnly } from '@trustsystem/identity/nest';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import { ApiError } from '@trustsystem/errors';
import { GOVERNANCE_PERMISSIONS } from '@trustsystem/governance-tool-core';
import { toWorkflowActor } from '@trustsystem/workflow-core';
import type { ApprovalWorkbenchService } from '@trustsystem/approval-workbench';
import { APPROVAL_WORKBENCH } from '../tokens';

/**
 * The Approval Workbench.
 *
 * The first real application built on the TrustOS foundation, and the shape of this file
 * is the point: it authorizes, resolves the actor, and hands over. There is no business
 * rule here, because every rule it would express is already enforced inside the workflow
 * engine, where a second caller cannot skip it.
 *
 * Three things are worth naming.
 *
 * **The actor is built by `toWorkflowActor`, never assembled inline.** That helper reads
 * roles and permissions from the resolved membership and throws without a tenant. An
 * actor assembled from a request body — or from a token claim — is how a workbench
 * becomes the weakest door into the workflow engine.
 *
 * **`@HumanActorsOnly` is on every decision.** An approval is a person's signature.
 * A service account holding an approval permission and a token is not a second reviewer,
 * and maker-checker means nothing if a machine can be the checker.
 *
 * **The workbench is optional.** A deployment that has not wired the workflow stores does
 * not get a half-working queue that returns empty pages; it gets a route that says the
 * application is not configured. Every method checks, because a `!` here would be a
 * runtime crash in the one deployment that skipped the wiring.
 */
@ApiTags('Approval Workbench')
@ApiBearerAuth()
@Controller('governance/approvals')
export class ApprovalWorkbenchController {
  constructor(
    @Optional()
    @Inject(APPROVAL_WORKBENCH)
    private readonly workbench: ApprovalWorkbenchService | null,
  ) {}

  /** The queue. `scope` selects pending, mine, completed, rejected or returned. */
  @Get()
  @ApiOperation({ summary: 'Approvals this person may act on, or has already decided' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  queue(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.require().queue(this.actorFor(actor, organizationId), query);
  }

  /** One request in full: metadata, decisions, audit timeline and eligible actions. */
  @Get(':instanceId')
  @ApiOperation({ summary: 'One approval request, with its history and eligible actions' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  detail(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('instanceId') instanceId: string,
  ) {
    return this.require().detail(this.actorFor(actor, organizationId), instanceId);
  }

  /**
   * Approve, reject or return for rework.
   *
   * One route for all three rather than three routes, because they differ only in the
   * action and the reason, and the authorization, freshness and maker-checker questions
   * are identical. Splitting them would be three places to forget `@HumanActorsOnly`.
   */
  @Post(':instanceId/decision')
  @HumanActorsOnly()
  @ApiOperation({ summary: 'Record a decision against an approval request' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  decide(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: Record<string, unknown>,
  ) {
    // `taskId` is context, not authority: the engine re-reads the task and re-checks
    // eligibility against it. Passing it lets the engine close the task in the same
    // transaction as the decision.
    const taskId = typeof body?.['taskId'] === 'string' ? body['taskId'] : null;
    const { taskId: _ignored, ...decision } = body ?? {};

    return this.require().decide(this.actorFor(actor, organizationId), instanceId, decision, {
      taskId,
    });
  }

  /** Adds a comment, when the deployment has wired comments. */
  @Post(':instanceId/comments')
  @HumanActorsOnly()
  @ApiOperation({ summary: 'Add a comment to an approval request' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  comment(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('instanceId') instanceId: string,
    @Body() body: { body?: string },
  ) {
    return this.require().comment(
      this.actorFor(actor, organizationId),
      instanceId,
      body?.body ?? '',
    );
  }

  /** Reassigns a task, when the deployment has wired reassignment. */
  @Post('tasks/:taskId/reassign')
  @HumanActorsOnly()
  @ApiOperation({ summary: 'Reassign an approval task to another reviewer' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key)
  reassign(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('taskId') taskId: string,
    @Body() body: { assigneeUserId?: string; reason?: string },
  ) {
    return this.require().reassign(this.actorFor(actor, organizationId), taskId, {
      assigneeUserId: body?.assigneeUserId ?? '',
      reason: body?.reason ?? '',
    });
  }

  // --- internals ------------------------------------------------------------

  private require(): ApprovalWorkbenchService {
    if (!this.workbench) {
      throw ApiError.notFound('The Approval Workbench is not configured for this deployment.', {
        reason: 'approval_workbench_unavailable',
      });
    }
    return this.workbench;
  }

  /**
   * Projects the verified caller into the workflow shape.
   *
   * `toWorkflowActor` throws without a tenant, which is the behaviour wanted: a workflow
   * operation with no organization is a query with no `WHERE` clause. The organization
   * comes from the tenant decorator, which resolves it from the verified membership —
   * never from the body, the query or a token claim.
   */
  private actorFor(actor: ActorContext, organizationId: string) {
    return toWorkflowActor({ ...actor, organizationId });
  }
}
