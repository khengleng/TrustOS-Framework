import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import { z } from '@trustsystem/validation';
import { ZodValidationPipe } from '@trustsystem/validation/nest';
import { toWorkflowActor, WORKFLOW_PERMISSIONS } from '@trustsystem/workflow-core';
import { describeSla, type SlaService } from '@trustsystem/workflow-sla';
import type { EscalationService } from '@trustsystem/workflow-escalation';
import type { TaskService } from '@trustsystem/workflow-tasks';
import { ESCALATION_SERVICE, SLA_SERVICE, TASK_SERVICE } from '../tokens';

/*
 * Request schemas.
 *
 * Declared above the controller rather than below it. A `const` referenced inside a
 * parameter decorator is evaluated when the class is defined, not when the method runs, so a
 * schema declared afterwards is a temporal dead zone error at class-definition time — which
 * TypeScript reports and which is easy to introduce by writing the routes first.
 */
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const sweepSchema = z.object({
  /**
   * A batch ceiling.
   *
   * Bounded, so one sweep cannot hold a transaction open across an entire backlog. A
   * scheduler that needs more calls again; that is cheaper than a lock held for a minute.
   */
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * Operations: SLA state, escalations, and the sweeps.
 *
 * The two sweep routes exist because a scheduler has to call *something*. They are POSTs
 * rather than GETs — they have effects — and they are idempotent, so a cron that fires twice
 * or a retry after a timeout does nothing the second time.
 *
 * Being HTTP routes rather than an internal timer is deliberate: it means the schedule lives
 * where the deployment's other schedules live, and the sweep can be triggered by hand during
 * an incident without restarting anything.
 */
@ApiTags('workflow/operations')
@ApiBearerAuth('access-token')
@Controller('workflow/operations')
export class OperationsController {
  constructor(
    @Inject(SLA_SERVICE) private readonly sla: SlaService,
    @Inject(ESCALATION_SERVICE) private readonly escalation: EscalationService,
    @Inject(TASK_SERVICE) private readonly tasks: TaskService,
  ) {}

  @Get('instances/:instanceId/sla')
  @RequirePermissions(WORKFLOW_PERMISSIONS.SLA_READ.key)
  @Authorize('workflow.sla.read', 'WorkflowInstance')
  @ApiOperation({ summary: 'SLA state for an instance, recomputed on read' })
  @ApiOkResponse({
    description:
      'Derived from the timestamps rather than stored, so a scheduler being down does not ' +
      'make this answer wrong.',
  })
  async slaFor(@OrganizationId() organizationId: string, @Param('instanceId') instanceId: string) {
    const records = await this.sla.statusForInstance(instanceId, organizationId);

    return records.map((record) => ({
      id: record.id,
      kind: record.kind,
      severity: record.severity,
      stepKey: record.stepKey,
      status: record.evaluation.status,
      consumedPercent: record.evaluation.consumedPercent,
      remainingSeconds: record.evaluation.remainingSeconds,
      effectiveDueAt: record.evaluation.effectiveDueAt,
      // Rendered for a dashboard cell, because "breached by 2h" is read and a duration in
      // seconds is not.
      summary: describeSla(record, record.evaluation),
    }));
  }

  @Post('sla/:slaId/pause')
  @RequirePermissions(WORKFLOW_PERMISSIONS.SLA_PAUSE.key)
  @Authorize('workflow.sla.pause', 'WorkflowSla')
  @ApiOperation({ summary: 'Stop an SLA clock while waiting on somebody outside' })
  @ApiOkResponse({
    description:
      'Requires a reason and is audited. Pausing an SLA is how a target is met on paper, so it ' +
      'has to be visible.',
  })
  pause(
    @OrganizationId() organizationId: string,
    @Param('slaId') slaId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.sla.pause({ slaId, organizationId, reason: body.reason });
  }

  @Post('sla/:slaId/resume')
  @RequirePermissions(WORKFLOW_PERMISSIONS.SLA_PAUSE.key)
  @Authorize('workflow.sla.pause', 'WorkflowSla')
  @ApiOperation({ summary: 'Restart a paused clock, banking the paused time' })
  @ApiOkResponse({
    description:
      'Paused time accumulates rather than overwriting, so several pause cycles cannot be used ' +
      'to avoid a breach indefinitely.',
  })
  resume(@OrganizationId() organizationId: string, @Param('slaId') slaId: string) {
    return this.sla.resume({ slaId, organizationId });
  }

  @Post('sweeps/sla')
  @RequirePermissions(WORKFLOW_PERMISSIONS.ESCALATION_TRIGGER.key)
  @ApiOperation({ summary: 'Claim crossed SLA thresholds and fire their escalations' })
  @ApiOkResponse({
    description:
      'Idempotent. A breached SLA stays breached, so without the idempotency key a sweep would ' +
      'page somebody every minute until the queue drained.',
  })
  async sweepSla(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(sweepSchema)) query: z.infer<typeof sweepSchema>,
  ) {
    const claimed = await this.sla.sweep({ organizationId, limit: query.limit });

    /*
     * The escalation half needs the definition's rules for each SLA, which means loading the
     * instance and its version. The example resolves nothing and reports what it claimed,
     * because wiring the resolver is a deployment decision: which escalation rules apply to
     * a platform-owned definition is a question only the deployment can answer.
     *
     * A deployment supplies `resolve` and the two halves join up.
     */
    const outcomes = await this.escalation.escalateSlaBreaches({
      breached: claimed.breached,
      warned: claimed.warned,
      resolve: async () => null,
    });

    return {
      warned: claimed.warned.length,
      breached: claimed.breached.length,
      escalations: outcomes.length,
      note:
        outcomes.length === 0 && claimed.breached.length + claimed.warned.length > 0
          ? 'Thresholds were claimed but no escalation resolver is registered, so no rules ran. ' +
            'See docs/workflow-operations.md.'
          : null,
    };
  }

  @Post('sweeps/tasks')
  @RequirePermissions(WORKFLOW_PERMISSIONS.ESCALATION_TRIGGER.key)
  @ApiOperation({ summary: 'Expire tasks past their deadline' })
  @ApiOkResponse({
    description:
      'A task somebody acted on in the same moment is skipped rather than retried: their ' +
      'action is more current than the sweep’s opinion that the task is abandoned.',
  })
  sweepTasks(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(sweepSchema)) query: z.infer<typeof sweepSchema>,
  ) {
    return this.tasks.expireOverdue({ organizationId, limit: query.limit });
  }

  @Get('instances/:instanceId/escalations')
  @RequirePermissions(WORKFLOW_PERMISSIONS.ESCALATION_READ.key)
  @Authorize('workflow.escalation.read', 'WorkflowInstance')
  @ApiOperation({ summary: 'Escalation history for an instance' })
  @ApiOkResponse({
    description:
      'Includes failed escalations. "The pager did not fire and there is no record of why" is ' +
      'the worst possible state, so a failure keeps its row and its reason.',
  })
  escalations(@CurrentUser() actor: ActorContext, @Param('instanceId') instanceId: string) {
    const workflowActor = toWorkflowActor(actor);
    return this.escalation.history(instanceId, workflowActor.organizationId);
  }
}
