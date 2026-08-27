import { Body, Controller, Get, Inject, Optional, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { ApiError } from '@trustos/errors';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { OrganizationId } from '@trustos/tenancy';
import type { AuditService } from '@trustos/audit';
import { apiClassification, type ApiCatalog } from '@trustos/api-catalog';
import type { ConsumerRegistry } from '@trustos/api-consumer';
import {
  analyseCompatibility,
  unacknowledgedConsumers,
  type MigrationPlan,
} from '@trustos/api-versioning';
import { readQuota, type Quota, type QuotaUsageStore } from '@trustos/api-quota';
import {
  accessRequestSchema,
  assertSandboxOnly,
  credentialDisplay,
  decideRequest,
  developerRegistrationSchema,
  stalledRequests,
  visibilityFor,
  visibleCatalog,
  type AccessRequest,
  type DeveloperRegistration,
} from '@trustos/developer-access';
import {
  API_CATALOG,
  AUDIT_SERVICE,
  CONSUMER_REGISTRY,
  KEY_METADATA,
  PORTAL_STATE,
  QUOTA_STORE,
} from '../tokens';
import { PORTAL_PERMISSIONS } from '../permissions';

export interface PortalState {
  registrations: DeveloperRegistration[];
  requests: AccessRequest[];
  migrationPlans: MigrationPlan[];
  quotas: Quota[];
}

/**
 * The API Developer Portal.
 *
 * The most-visited and least-controlled surface a platform has: easy to sign up for, holds
 * credentials, and describes every API in the estate. So the interesting design questions here are
 * all about what it refuses.
 *
 * **The catalog is filtered by what the caller may see, and the filter hides existence.** Not a
 * greyed-out row saying "contact us for access to the Ledger API" — that row is most of the
 * reconnaissance an attacker wanted, served by the documentation site.
 *
 * **No route issues a production credential.** Registration produces a sandbox key; production
 * access is a *request*, decided by a named person, which creates a consumer through the registry.
 * Self-service ends at the sandbox boundary.
 *
 * **No route returns a key.** `@trustos/api-keys` hashes on creation, so the value cannot be
 * recovered; this controller returns a prefix and says so, because the portal is exactly where
 * somebody would add a "show key" button.
 */
@ApiTags('Developer portal')
@ApiBearerAuth()
@Controller('portal')
export class PortalController {
  constructor(
    @Inject(API_CATALOG) private readonly catalog: ApiCatalog,
    @Inject(CONSUMER_REGISTRY) private readonly consumers: ConsumerRegistry,
    @Inject(PORTAL_STATE) private readonly state: PortalState,
    @Inject(QUOTA_STORE) private readonly quotaStore: QuotaUsageStore,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    /**
     * Reads credential *metadata* from the deployment's key store — never a key.
     *
     * Optional, and absent by default: a portal with no key store shows the reference and says the
     * key is not stored, which is true and useless rather than untrue and helpful.
     */
    @Inject(KEY_METADATA)
    @Optional()
    private readonly keyMetadata?: (credentialId: string) => {
      keyPrefix: string;
      name: string;
      createdAt: string;
      expiresAt: string | null;
      lastUsedAt: string | null;
    } | null,
  ) {}

  private viewer(actor: ActorContext) {
    /*
     * The consumer is resolved from the actor, never from a parameter. A `consumerId` query
     * parameter here would let any signed-in developer read any other consumer's entitlements,
     * usage and documentation — the classic IDOR, on the surface most exposed to the internet.
     */
    const consumer = this.consumers
      .list()
      .find(
        (candidate) =>
          candidate.technicalContact === actor.email || candidate.ownerId === actor.userId,
      );

    return { consumer: consumer ?? null };
  }

  @Get('apis')
  @ApiOperation({ summary: 'The catalog, as this viewer may see it' })
  @ApiOkResponse({ description: 'Only APIs this viewer may know about.' })
  @RequirePermissions(PORTAL_PERMISSIONS.READ.key)
  @Authorize(PORTAL_PERMISSIONS.READ.key)
  apis(@CurrentUser() actor: ActorContext) {
    return { apis: visibleCatalog({ catalog: this.catalog, viewer: this.viewer(actor) }) };
  }

  @Get('apis/:apiId/:version')
  @ApiOperation({ summary: 'One API, with documentation if this viewer may read it' })
  @RequirePermissions(PORTAL_PERMISSIONS.READ.key)
  @Authorize(PORTAL_PERMISSIONS.READ.key)
  api(
    @CurrentUser() actor: ActorContext,
    @Param('apiId') apiId: string,
    @Param('version') version: string,
  ) {
    const api = this.catalog.get(apiId, version);
    const viewer = this.viewer(actor);

    /*
     * A 404 rather than a 403 when the viewer may not know it exists. A 403 confirms the API is
     * real, which is the fact the visibility rule exists to withhold.
     */
    if (!api) throw ApiError.notFound(`No such API.`);

    const visibility = visibilityFor({ api, viewer });
    if (!visibility.listed) throw ApiError.notFound(`No such API.`);

    return {
      apiId: api.apiId,
      name: api.name,
      version: api.version,
      lifecycle: api.lifecycle,
      classification: apiClassification(api),
      authentication: api.authentication,
      retirementDate: api.retirementDate,
      supersededBy: api.supersededBy,
      visibility,
      // The specification only when the viewer is entitled to it: an OpenAPI document names
      // fields, error codes and business rules.
      openApiRef: visibility.documented ? api.openApiRef : null,
      operations: visibility.documented ? api.operations : null,
    };
  }

  @Get('apis/:apiId/:from/changes/:to')
  @ApiOperation({ summary: 'What changed between two versions' })
  @RequirePermissions(PORTAL_PERMISSIONS.READ.key)
  @Authorize(PORTAL_PERMISSIONS.READ.key)
  changes(
    @CurrentUser() actor: ActorContext,
    @Param('apiId') apiId: string,
    @Param('from') from: string,
    @Param('to') to: string,
  ) {
    const before = this.catalog.require(apiId, from);
    const after = this.catalog.require(apiId, to);
    const viewer = this.viewer(actor);

    if (!visibilityFor({ api: after, viewer }).documented) {
      throw ApiError.notFound('No such API.');
    }

    /*
     * Published to consumers deliberately. A consumer who can see exactly what breaks, and what
     * they have to change, migrates; one who is told "2.0 contains breaking changes" opens a
     * ticket.
     */
    return analyseCompatibility(before, after);
  }

  @Get('deprecations')
  @ApiOperation({ summary: 'What is retiring, and what this viewer has to do about it' })
  @RequirePermissions(PORTAL_PERMISSIONS.READ.key)
  @Authorize(PORTAL_PERMISSIONS.READ.key)
  deprecations(@CurrentUser() actor: ActorContext) {
    const viewer = this.viewer(actor);
    const consumerId = viewer.consumer?.consumerId;

    return {
      notices: this.state.migrationPlans
        .filter((plan) =>
          consumerId
            ? plan.consumerImpacts.some((impact) => impact.consumerId === consumerId)
            : false,
        )
        .map((plan) => ({
          apiId: plan.apiId,
          fromVersion: plan.fromVersion,
          toVersion: plan.toVersion,
          deprecationPeriodDays: plan.deprecationPeriodDays,
          migrationGuide: plan.migrationGuide,
          // This consumer's impact, not everybody's. A notice listing other consumers' integrations
          // would leak the customer list.
          yourImpact:
            plan.consumerImpacts.find((impact) => impact.consumerId === consumerId)?.impact ?? null,
        })),
    };
  }

  @Get('credentials')
  @ApiOperation({ summary: 'Credential metadata — never a key' })
  @RequirePermissions(PORTAL_PERMISSIONS.READ.key)
  @Authorize(PORTAL_PERMISSIONS.READ.key)
  credentials(@CurrentUser() actor: ActorContext) {
    const consumer = this.viewer(actor).consumer;

    /*
     * A credential id is a *reference* into `@trustos/api-keys`, not the key and not derived from
     * it. Slicing an id to produce a "prefix" would be wrong twice over: the prefix a key
     * authenticates with comes from the key store, and treating the two as the same thing is how
     * an id that happened to be derived from a key ends up echoed back.
     *
     * So the portal shows what it holds — the reference — and says plainly that the key is gone.
     * A deployment that wants the real prefix reads it from the key store and passes it in.
     */
    return {
      credentials: (consumer?.credentialIds ?? []).map((credentialId) => {
        const metadata = this.keyMetadata?.(credentialId) ?? null;

        return {
          credentialId,
          ...credentialDisplay({
            keyPrefix: metadata?.keyPrefix ?? 'unavailable',
            name: metadata?.name ?? credentialId,
            createdAt: metadata?.createdAt ?? consumer?.createdAt ?? new Date(0).toISOString(),
            expiresAt: metadata?.expiresAt ?? null,
            lastUsedAt: metadata?.lastUsedAt ?? null,
          }),
        };
      }),
    };
  }

  @Get('usage')
  @ApiOperation({ summary: 'Quota consumption for this viewer' })
  @RequirePermissions(PORTAL_PERMISSIONS.READ.key)
  @Authorize(PORTAL_PERMISSIONS.READ.key)
  async usage(@CurrentUser() actor: ActorContext) {
    const consumer = this.viewer(actor).consumer;
    if (!consumer) return { usage: [] };

    const quotas = this.state.quotas.filter((quota) => quota.subjectId === consumer.consumerId);

    return {
      usage: await Promise.all(
        // Reads without consuming: a usage page that counted against the quota would be the most
        // annoying bug in the platform.
        quotas.map((quota) => readQuota({ quota, store: this.quotaStore, at: new Date() })),
      ),
    };
  }

  @Post('registrations')
  @ApiOperation({ summary: 'Register as a developer — sandbox only' })
  @RequirePermissions(PORTAL_PERMISSIONS.REGISTER.key)
  @Authorize(PORTAL_PERMISSIONS.REGISTER.key)
  async register(@CurrentUser() actor: ActorContext, @Body() body: unknown) {
    const registration = developerRegistrationSchema.parse(body);

    // The schema already pins the environment to development; this states the rule at the seam
    // where somebody would later add a parameter.
    assertSandboxOnly({ registration, environment: registration.environment });

    this.state.registrations.push(registration);

    await this.audit.record({
      action: 'portal.developer.registered',
      entityType: 'developer_registration',
      entityId: registration.registrationId,
      actorId: actor.userId,
      organizationId: null,
      metadata: {
        environment: registration.environment,
        claimed: registration.claimedOrganization,
      },
    });

    return {
      registrationId: registration.registrationId,
      environment: registration.environment,
      note: 'Sandbox credentials only. Production access is requested and approved by a named person.',
    };
  }

  @Post('access-requests')
  @ApiOperation({ summary: 'Request access to an API' })
  @RequirePermissions(PORTAL_PERMISSIONS.REQUEST_ACCESS.key)
  @Authorize(PORTAL_PERMISSIONS.REQUEST_ACCESS.key)
  async requestAccess(@CurrentUser() actor: ActorContext, @Body() body: unknown) {
    const request = accessRequestSchema.parse(body);
    this.state.requests.push(request);

    await this.audit.record({
      action: 'portal.access.requested',
      entityType: 'access_request',
      entityId: request.requestId,
      actorId: actor.userId,
      organizationId: null,
      metadata: {
        apiId: request.apiId,
        environment: request.environment,
        expectedCallsPerDay: request.expectedCallsPerDay,
      },
    });

    return { requestId: request.requestId, status: request.status };
  }

  @Get('access-requests')
  @ApiOperation({ summary: 'The approval queue' })
  @RequirePermissions(PORTAL_PERMISSIONS.APPROVE_ACCESS.key)
  @Authorize(PORTAL_PERMISSIONS.APPROVE_ACCESS.key)
  queue(@Query('status') status?: string) {
    return {
      requests: status
        ? this.state.requests.filter((request) => request.status === status)
        : this.state.requests,
      // A queue nobody drains is how developers conclude the platform is not serious.
      stalled: stalledRequests(this.state.requests, { asOf: new Date() }),
    };
  }

  @Post('access-requests/:requestId/decision')
  @ApiOperation({ summary: 'Approve or reject an access request' })
  @RequirePermissions(PORTAL_PERMISSIONS.APPROVE_ACCESS.key)
  @Authorize(PORTAL_PERMISSIONS.APPROVE_ACCESS.key)
  async decide(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('requestId') requestId: string,
    @Body()
    body: {
      decision: 'approved' | 'rejected';
      reason: string;
      consumerId?: string;
      acknowledgedClassification?: string;
    },
  ) {
    const request = this.state.requests.find((candidate) => candidate.requestId === requestId);
    if (!request) throw ApiError.notFound(`No request called ${requestId}.`);

    const api = this.catalog.current(request.apiId);

    /*
     * Refuses an approval above the developer ceiling without an explicit acknowledgement of what
     * the data is. An approver working through a queue is the mechanism by which somebody ends up
     * entitled to restricted data, and the acknowledgement is what interrupts it.
     */
    const decided = decideRequest({
      request,
      decision: body.decision,
      decidedBy: actor.userId,
      reason: body.reason,
      ...(body.consumerId ? { consumerId: body.consumerId } : {}),
      ...(api ? { api } : {}),
      ...(body.acknowledgedClassification
        ? { acknowledgedClassification: body.acknowledgedClassification }
        : {}),
      at: new Date(),
    });

    const index = this.state.requests.indexOf(request);
    this.state.requests[index] = decided;

    await this.audit.record({
      action: body.decision === 'approved' ? 'portal.access.approved' : 'portal.access.rejected',
      entityType: 'access_request',
      entityId: requestId,
      actorId: actor.userId,
      organizationId,
      after: { status: decided.status, consumerId: decided.consumerId },
      metadata: {
        reason: body.reason,
        apiId: request.apiId,
        environment: request.environment,
        acknowledgedClassification: body.acknowledgedClassification ?? null,
      },
    });

    return decided;
  }

  @Get('migration-plans/:apiId/outstanding')
  @ApiOperation({ summary: 'Consumers who have not acknowledged a migration' })
  @RequirePermissions(PORTAL_PERMISSIONS.APPROVE_ACCESS.key)
  @Authorize(PORTAL_PERMISSIONS.APPROVE_ACCESS.key)
  outstanding(@Param('apiId') apiId: string) {
    const plan = this.state.migrationPlans.find((candidate) => candidate.apiId === apiId);
    if (!plan) throw ApiError.notFound(`No migration plan for ${apiId}.`);

    return { outstanding: unacknowledgedConsumers(plan, new Date()) };
  }
}
