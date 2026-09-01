import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import type { AuditService } from '@trustsystem/audit';
import { apiClassification, type ApiCatalog } from '@trustsystem/api-catalog';
import { reviewConsumer, type ConsumerRegistry } from '@trustsystem/api-consumer';
import { analyseCompatibility } from '@trustsystem/api-versioning';
import { API_CATALOG, AUDIT_SERVICE, CONSUMER_REGISTRY } from '../tokens';
import { ENTERPRISE_PERMISSIONS } from '../permissions';

/**
 * API governance: catalog, consumers, versions.
 *
 * The compatibility route is the one worth reading. It compares two versions and reports the
 * required bump, and it is exposed as a *read* — anybody who may see the catalog may check
 * whether a change breaks. Putting it behind the publish permission would mean the check happens
 * once, by the person publishing, at the moment they are least inclined to hear the answer.
 */
@ApiTags('API governance')
@ApiBearerAuth()
@Controller('enterprise/apis')
export class ApiGovernanceController {
  constructor(
    @Inject(API_CATALOG) private readonly catalog: ApiCatalog,
    @Inject(CONSUMER_REGISTRY) private readonly consumers: ConsumerRegistry,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Browse the API catalog' })
  @ApiOkResponse({ description: 'APIs with their derived classification and consumer counts.' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.API_CATALOG_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.API_CATALOG_READ.key)
  list(@Query('lifecycle') lifecycle?: string, @Query('domain') domain?: string) {
    const apis = this.catalog.list({
      ...(lifecycle ? { lifecycle: lifecycle as never } : {}),
      ...(domain ? { domain } : {}),
    });

    return {
      apis: apis.map((api) => ({
        apiId: api.apiId,
        name: api.name,
        version: api.version,
        lifecycle: api.lifecycle,
        environment: api.environment,
        businessOwnerId: api.businessOwnerId,
        technicalOwnerId: api.technicalOwnerId,
        // Derived from the operations, not declared. See @trustsystem/api-catalog.
        classification: apiClassification(api),
        consumers: this.consumers.consumersOf(api.apiId, api.version).length,
        retirementDate: api.retirementDate,
      })),
      findings: this.catalog.analyse({
        consumersOf: (apiId, version) => this.consumers.consumersOf(apiId, version),
      }),
    };
  }

  @Get(':apiId/versions')
  @ApiOperation({ summary: 'Every version of an API' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.API_CATALOG_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.API_CATALOG_READ.key)
  versions(@Param('apiId') apiId: string) {
    return {
      apiId,
      versions: this.catalog.versionsOf(apiId).map((api) => ({
        version: api.version,
        lifecycle: api.lifecycle,
        consumers: this.consumers.consumersOf(api.apiId, api.version),
      })),
      current: this.catalog.current(apiId)?.version ?? null,
    };
  }

  @Get(':apiId/compatibility')
  @ApiOperation({ summary: 'What changed between two versions, and what bump it requires' })
  @ApiOkResponse({ description: 'Every change classified, with the minimum version bump.' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.API_CATALOG_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.API_CATALOG_READ.key)
  compatibility(
    @Param('apiId') apiId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const analysis = analyseCompatibility(
      this.catalog.require(apiId, from),
      this.catalog.require(apiId, to),
    );

    return {
      ...analysis,
      /*
       * Who would be affected, named. "This is a breaking change" is a fact about a contract;
       * "this breaks these four consumers" is a fact somebody has to act on.
       */
      affectedConsumers: this.consumers.consumersOf(apiId, from),
    };
  }

  @Get('consumers')
  @ApiOperation({ summary: 'API consumers and their entitlements' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.API_CONSUMER_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.API_CONSUMER_READ.key)
  listConsumers(@Query('environment') environment?: string) {
    const consumers = this.consumers.list(environment ? { environment } : {});
    const at = new Date();

    return {
      consumers: consumers.map((consumer) => ({
        consumerId: consumer.consumerId,
        name: consumer.name,
        kind: consumer.kind,
        status: consumer.status,
        environment: consumer.environment,
        organizationId: consumer.organizationId,
        entitlements: consumer.entitlements.length,
        lastReviewedAt: consumer.lastReviewedAt,
        findings: reviewConsumer({ consumer, catalog: this.catalog, at }),
      })),
    };
  }

  @Post(':apiId/versions/:version/publish')
  @ApiOperation({ summary: 'Publish an API version' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.API_PUBLISH.key)
  @Authorize(ENTERPRISE_PERMISSIONS.API_PUBLISH.key)
  async publish(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('apiId') apiId: string,
    @Param('version') version: string,
    @Body() body: { reason: string },
  ) {
    /*
     * The catalog refuses an owner publishing their own API into production. That check lives in
     * the catalog rather than here so it holds for every caller, including the CLI — a control
     * that exists only in one controller is a control with a bypass.
     */
    const published = this.catalog.transition({
      apiId,
      version,
      to: 'PUBLISHED',
      actorId: actor.userId,
      reason: body.reason,
    });

    await this.audit.record({
      action: 'enterprise.api.published',
      entityType: 'api',
      entityId: `${apiId}@${version}`,
      actorId: actor.userId,
      organizationId,
      after: { lifecycle: 'PUBLISHED' },
      metadata: {
        reason: body.reason,
        businessOwner: published.businessOwnerId,
        technicalOwner: published.technicalOwnerId,
        classification: apiClassification(published),
      },
    });

    return { apiId, version, lifecycle: published.lifecycle, approvedBy: published.approvedBy };
  }
}
