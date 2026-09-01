import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import { TIER_EXPECTATIONS, type ServiceRegistry } from '@trustsystem/sre-core';
import {
  aggregate,
  sufficientToJudge,
  type SliMeasurement,
  type SliRegistry,
} from '@trustsystem/sli';
import { burnAlert, burnRate, errorBudget, evaluateSlo, type Slo } from '@trustsystem/slo';
import type { DependencyHealthBoard } from '@trustsystem/dependency-health';
import {
  incidentMetrics,
  overdueActions,
  type Incident,
  type IncidentManager,
} from '@trustsystem/incident-management';
import {
  HEALTH_BOARD,
  INCIDENT_MANAGER,
  SERVICE_REGISTRY,
  SLI_REGISTRY,
  SRE_STATE,
} from '../tokens';
import { SRE_PERMISSIONS } from '../permissions';

export interface SreState {
  slos: Slo[];
  measurements: SliMeasurement[];
  incidents: Incident[];
}

/**
 * The SRE Operations Console.
 *
 * One rule shapes every read here: **nothing is reported as healthy by default.** A service with
 * no measurements reports as unmeasured, an objective with too little traffic reports as
 * insufficient data, and a dependency nobody probed recently reports as unknown. All three would
 * be greener if they defaulted the other way, and all three would be lying.
 *
 * That matters more on a dashboard than in a library, because a dashboard is read at speed by
 * somebody deciding whether to escalate. A green square that means "we have not looked" is worse
 * than no square.
 */
@ApiTags('SRE operations')
@ApiBearerAuth()
@Controller('sre')
export class OperationsController {
  constructor(
    @Inject(SERVICE_REGISTRY) private readonly registry: ServiceRegistry,
    @Inject(HEALTH_BOARD) private readonly health: DependencyHealthBoard,
    @Inject(SLI_REGISTRY) private readonly slis: SliRegistry,
    @Inject(SRE_STATE) private readonly state: SreState,
    @Inject(INCIDENT_MANAGER) private readonly incidents: IncidentManager,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Service health, objectives, budgets and open incidents' })
  @ApiOkResponse({ description: 'The operations dashboard, worst first.' })
  @RequirePermissions(SRE_PERMISSIONS.READ.key)
  @Authorize(SRE_PERMISSIONS.READ.key)
  dashboard(@Query('environment') environment?: string) {
    const board = this.health.board(environment ? { environment } : {});
    const open = this.state.incidents.filter((incident) => incident.state !== 'closed');

    return {
      services: board.map((service) => ({
        ...service,
        tier: this.registry.get(service.serviceId)?.tier ?? null,
        objectives: this.objectivesFor(service.serviceId),
      })),
      openIncidents: open.map((incident) => ({
        incidentId: incident.incidentId,
        title: incident.title,
        severity: incident.severity,
        state: incident.state,
        ownerId: incident.ownerId,
        affectedServiceIds: incident.affectedServiceIds,
        metrics: incidentMetrics(incident),
      })),
      // Dependencies nobody is probing. Surfaced separately because the remedy is a probe, not an
      // engineer — and because they would otherwise sit in the board looking merely unremarkable.
      unobserved: this.health.unobserved(),
      graphFindings: this.registry.analyse(),
      overdueCorrectiveActions: overdueActions(this.state.incidents, new Date()),
    };
  }

  @Get('services')
  @ApiOperation({ summary: 'The service registry' })
  @RequirePermissions(SRE_PERMISSIONS.READ.key)
  @Authorize(SRE_PERMISSIONS.READ.key)
  services(@Query('tier') tier?: string) {
    return {
      services: this.registry.list(tier ? { tier: tier as never } : {}).map((service) => ({
        serviceId: service.serviceId,
        name: service.name,
        tier: service.tier,
        expectation: TIER_EXPECTATIONS[service.tier],
        ownerTeam: service.ownerTeam,
        onCallRotation: service.onCallRotation,
        dependencies: service.dependencies.length,
        // The question every incident asks and nobody answers accurately from memory.
        dependents: this.registry.dependents(service.serviceId),
        health: this.health.serviceHealth(service.serviceId).state,
      })),
      findings: this.registry.analyse(),
    };
  }

  @Get('services/:serviceId')
  @ApiOperation({ summary: 'One service, its dependencies and its runbooks' })
  @RequirePermissions(SRE_PERMISSIONS.READ.key)
  @Authorize(SRE_PERMISSIONS.READ.key)
  service(@Param('serviceId') serviceId: string) {
    const service = this.registry.require(serviceId);

    return {
      service,
      health: this.health.serviceHealth(serviceId),
      runbooks: this.registry.runbooksFor(serviceId),
      dependents: this.registry.dependents(serviceId),
      objectives: this.objectivesFor(serviceId),
      maintenance: this.registry.inMaintenance(serviceId, new Date()),
    };
  }

  @Get('slo')
  @ApiOperation({ summary: 'Objectives with their error budgets and burn rates' })
  @RequirePermissions(SRE_PERMISSIONS.READ.key)
  @Authorize(SRE_PERMISSIONS.READ.key)
  objectives(@Query('serviceId') serviceId?: string) {
    const slos = serviceId
      ? this.state.slos.filter((slo) => slo.serviceId === serviceId)
      : this.state.slos;

    return { objectives: slos.map((slo) => this.statusOf(slo)) };
  }

  @Get('incidents')
  @ApiOperation({ summary: 'Incidents, open first' })
  @RequirePermissions(SRE_PERMISSIONS.READ.key)
  @Authorize(SRE_PERMISSIONS.READ.key)
  listIncidents(@Query('state') state?: string) {
    const incidents = state
      ? this.state.incidents.filter((incident) => incident.state === state)
      : this.state.incidents;

    return {
      incidents: incidents.map((incident) => ({
        ...incident,
        metrics: incidentMetrics(incident),
        // Reads the registry rather than the incident, so an impact statement cannot go stale.
        alsoAffected: incident.affectedServiceIds.flatMap((id) => this.registry.dependents(id)),
      })),
    };
  }

  @Post('incidents')
  @ApiOperation({ summary: 'Declare an incident' })
  @RequirePermissions(SRE_PERMISSIONS.INCIDENT_DECLARE.key)
  @Authorize(SRE_PERMISSIONS.INCIDENT_DECLARE.key)
  async declare(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body()
    body: {
      incidentId: string;
      title: string;
      severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
      affectedServiceIds: string[];
      impact: string;
      detectionSource:
        'alert' | 'customer_report' | 'internal_report' | 'routine_check' | 'unknown';
    },
  ) {
    /*
     * Severity comes from the caller and is never derived. It is a judgement about impact, and a
     * rule that guessed it from symptoms would be wrong often enough that people would override
     * it — at which point the recorded severity means nothing.
     */
    const incident = await this.incidents.declare({
      incidentId: body.incidentId,
      title: body.title,
      severity: body.severity,
      ownerId: actor.userId,
      affectedServiceIds: body.affectedServiceIds,
      impact: body.impact,
      detectionSource: body.detectionSource,
      organizationId,
    });

    this.state.incidents.push(incident);
    return incident;
  }

  @Post('incidents/:incidentId/notes')
  @ApiOperation({ summary: 'Append to the timeline' })
  @RequirePermissions(SRE_PERMISSIONS.INCIDENT_UPDATE.key)
  @Authorize(SRE_PERMISSIONS.INCIDENT_UPDATE.key)
  async note(
    @CurrentUser() actor: ActorContext,
    @Param('incidentId') incidentId: string,
    @Body() body: { kind: string; note: string; occurredAt?: string },
  ) {
    // Append only. There is no route that edits or removes an entry, because an editable timeline
    // is a timeline that gets tidied before the review.
    const incident = this.requireIncident(incidentId);

    const next = await this.incidents.note(incident, {
      kind: body.kind as never,
      actorId: actor.userId,
      note: body.note,
      ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}),
    });

    this.replace(next);
    return next;
  }

  @Post('incidents/:incidentId/transitions')
  @ApiOperation({ summary: 'Move an incident through its states' })
  @RequirePermissions(SRE_PERMISSIONS.INCIDENT_UPDATE.key)
  @Authorize(SRE_PERMISSIONS.INCIDENT_UPDATE.key)
  async transition(
    @CurrentUser() actor: ActorContext,
    @Param('incidentId') incidentId: string,
    @Body() body: { to: string; note: string; mitigation?: string; resolution?: string },
  ) {
    const incident = this.requireIncident(incidentId);

    const next = await this.incidents.transition(incident, {
      to: body.to as never,
      actorId: actor.userId,
      note: body.note,
      ...(body.mitigation ? { mitigation: body.mitigation } : {}),
      ...(body.resolution ? { resolution: body.resolution } : {}),
    });

    this.replace(next);
    return next;
  }

  private requireIncident(incidentId: string): Incident {
    const incident = this.state.incidents.find((candidate) => candidate.incidentId === incidentId);
    if (!incident) throw new Error(`Incident ${incidentId} is not open in this console.`);
    return incident;
  }

  private replace(incident: Incident): void {
    const index = this.state.incidents.findIndex(
      (candidate) => candidate.incidentId === incident.incidentId,
    );
    if (index >= 0) this.state.incidents[index] = incident;
  }

  private objectivesFor(serviceId: string) {
    return this.state.slos
      .filter((slo) => slo.serviceId === serviceId)
      .map((slo) => this.statusOf(slo));
  }

  private statusOf(slo: Slo) {
    const measurements = this.state.measurements.filter(
      (measurement) => measurement.sliId === slo.sliId,
    );

    if (measurements.length === 0) {
      /*
       * No measurements is not 100%. An objective with nothing behind it reports as unmeasured, so
       * a reader can tell "nobody has looked" from "it is fine" — which a green square cannot.
       */
      return {
        sloId: slo.sloId,
        serviceId: slo.serviceId,
        target: slo.target,
        verdict: 'insufficient_data' as const,
        reason: 'No measurements have been recorded for this indicator.',
        budget: null,
        burn: null,
      };
    }

    const value = aggregate(measurements);
    const sufficiency = sufficientToJudge(value, {
      objectivePercentage: slo.target,
      ...(slo.minimumEvents !== null ? { minimumEvents: slo.minimumEvents } : {}),
    });

    const status = evaluateSlo(slo, value, sufficiency);
    const fast = burnRate({ slo, value, observedHours: 1 });
    const slow = burnRate({ slo, value, observedHours: 24 });

    return {
      ...status,
      budget: errorBudget(slo, value),
      burn: { fast, slow, alert: burnAlert({ fastBurn: fast, slowBurn: slow }) },
      indicator: this.slis.get(slo.sliId),
    };
  }
}
