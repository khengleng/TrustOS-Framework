import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { OrganizationId } from '@trustos/tenancy';
import type { AuditService } from '@trustos/audit';
import { assuranceOf, describeAssurance, type BackupInventory } from '@trustos/backup';
import { assertTestValidates, restoreTestSchema, type RestoreTest } from '@trustos/recovery';
import {
  assertActivatable,
  capabilityStatement,
  readinessOf,
  reviewPlans,
  type DrPlan,
} from '@trustos/disaster-recovery';
import { continuityStatus, gapAnalysis, type BusinessProcess } from '@trustos/continuity';
import { AUDIT_SERVICE, BACKUP_INVENTORY, CONTINUITY_STATE } from '../tokens';
import { ENTERPRISE_PERMISSIONS } from '../permissions';

export interface ContinuityState {
  processes: BusinessProcess[];
  drPlans: DrPlan[];
  restoreTests: RestoreTest[];
}

/**
 * The continuity dashboard: backups, restore tests, DR plans and exercises.
 *
 * Every read here reports what has been *demonstrated* rather than what is *configured*. A backup
 * row says "the job completed; nothing has ever been restored from it" rather than "healthy", and
 * a DR row says "documented, not demonstrated" until an exercise says otherwise.
 *
 * That wording is deliberate and it is not pessimism. This is the surface a readiness scorecard
 * quotes from, and a dashboard that rounds up produces a scorecard that rounds up, which produces
 * a board paper claiming a recovery capability nobody has ever exercised.
 */
@ApiTags('Continuity')
@ApiBearerAuth()
@Controller('enterprise/continuity')
export class ContinuityController {
  constructor(
    @Inject(BACKUP_INVENTORY) private readonly backups: BackupInventory,
    @Inject(CONTINUITY_STATE) private readonly state: ContinuityState,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The continuity dashboard' })
  @ApiOkResponse({
    description: 'Processes, their targets, and what has actually been demonstrated.',
  })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.CONTINUITY_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.CONTINUITY_READ.key)
  dashboard() {
    const rows = this.state.processes.map((process) =>
      continuityStatus({
        process,
        inventory: this.backups,
        restoreTests: this.state.restoreTests,
        drPlans: this.state.drPlans,
      }),
    );

    return {
      processes: rows,
      gaps: gapAnalysis({
        processes: this.state.processes,
        inventory: this.backups,
        restoreTests: this.state.restoreTests,
        drPlans: this.state.drPlans,
      }),
      // The one sentence a board paper is most likely to quote, written so it cannot round up.
      capability: capabilityStatement(this.state.drPlans),
    };
  }

  @Get('backups')
  @ApiOperation({ summary: 'The backup inventory, with what each backup actually establishes' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.CONTINUITY_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.CONTINUITY_READ.key)
  backupInventory() {
    return {
      backups: this.backups.list().map((backup) => ({
        backupId: backup.backupId,
        source: backup.source,
        environment: backup.environment,
        completedAt: backup.completedAt,
        // Never a location a reader could use to reach the backup, and never a credential.
        encrypted: backup.encrypted,
        classification: backup.classification,
        assurance: assuranceOf(backup),
        statement: describeAssurance(backup),
      })),
      findings: this.backups.analyse(new Date()),
    };
  }

  @Get('dr-plans')
  @ApiOperation({ summary: 'DR plans and what their exercises established' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.CONTINUITY_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.CONTINUITY_READ.key)
  plans() {
    return {
      plans: this.state.drPlans.map((plan) => ({
        planId: plan.planId,
        scenario: plan.scenario,
        title: plan.title,
        rtoMinutes: plan.rtoMinutes,
        rpoMinutes: plan.rpoMinutes,
        decisionAuthority: plan.decisionAuthority,
        readiness: readinessOf(plan),
      })),
      findings: reviewPlans({ plans: this.state.drPlans }),
    };
  }

  @Post('restore-tests')
  @ApiOperation({ summary: 'Record a restore test, and complete the backup it validates' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.CONTINUITY_WRITE.key)
  @Authorize(ENTERPRISE_PERMISSIONS.CONTINUITY_WRITE.key)
  async recordRestoreTest(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body() body: unknown,
  ) {
    const test = restoreTestSchema.parse(body);
    const backup = this.backups.require(test.backupId);

    /*
     * Refuses unless every required check passed. A restore test that partially succeeded is
     * useful information and is not evidence that the backup can be restored, and this is the
     * route where the two would otherwise get conflated.
     */
    const outcome = assertTestValidates({ test, backup });

    this.state.restoreTests.push(test);
    const updated = this.backups.recordRestoreTest({
      backupId: test.backupId,
      restoreTestId: test.restoreTestId,
      at: test.completedAt,
    });

    await this.audit.record({
      action: 'enterprise.continuity.restore_test_recorded',
      entityType: 'backup',
      entityId: test.backupId,
      actorId: actor.userId,
      organizationId,
      after: { lastRestoreTestId: test.restoreTestId },
      metadata: {
        durationMinutes: outcome.durationMinutes,
        targetEnvironment: test.targetEnvironment,
        performedBy: test.performedBy,
      },
    });

    return { outcome, assurance: assuranceOf(updated) };
  }

  @Post('dr-plans/:planId/activate')
  @ApiOperation({ summary: 'Activate a DR plan' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.DR_ACTIVATE.key)
  @Authorize(ENTERPRISE_PERMISSIONS.DR_ACTIVATE.key)
  async activate(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('planId') planId: string,
    @Body() body: { reason: string; force?: boolean },
  ) {
    const plan = this.state.drPlans.find((candidate) => candidate.planId === planId);
    if (!plan) {
      return { status: 'not_found', planId };
    }

    /*
     * An unexercised plan is refused unless somebody overrides it with a reason. The override
     * exists because a real disaster is not the moment to be blocked by governance — and a refusal
     * with no override is simply worked around outside the system, taking the record with it.
     */
    assertActivatable({
      plan,
      ...(body.force ? { force: { by: actor.userId, reason: body.reason } } : {}),
    });

    await this.audit.record({
      action: 'enterprise.continuity.dr_activated',
      entityType: 'dr_plan',
      entityId: planId,
      actorId: actor.userId,
      organizationId,
      metadata: {
        scenario: plan.scenario,
        reason: body.reason,
        overrode: body.force === true,
        readiness: readinessOf(plan).statement,
      },
    });

    return {
      status: 'activated',
      planId,
      scenario: plan.scenario,
      decisionAuthority: plan.decisionAuthority,
      deputyAuthority: plan.deputyAuthority,
      procedure: plan.procedure,
      communication: plan.communication,
    };
  }
}
