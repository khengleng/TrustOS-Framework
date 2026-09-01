import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import {
  GOVERNANCE_PERMISSIONS,
  type Environment,
  type InternalAppCatalog,
} from '@trustsystem/governance-tool-core';
import type { GovernanceActorContext } from '@trustsystem/governance-auth-context';
import type { GovernanceToolRuntime } from '@trustsystem/governance-tool-runtime';
import { requireOperation } from '@trustsystem/governance-tool-integration';
import { APP_CATALOG, GOVERNANCE_RUNTIME } from '../tokens';

/**
 * The gateway.
 *
 * Every internal application calls this and nothing else. That single-entrance property is what
 * the whole Governance Tool rests on: identity, tenancy, authorization, the access classes,
 * correlation and audit enrichment all happen here, so an internal tool that wanted to skip one
 * of them would have to stop being an internal tool.
 *
 * Two routes carry the traffic — `data` for reads and `actions` for everything else — and neither
 * takes a path, a query or a resource id from the caller. Both take a **declared id** from the
 * application's own definition, which the catalog resolved. A gateway that accepted a path would
 * be a gateway through which an application reaches something it never declared, and the
 * declaration is the thing security reviewed.
 *
 * The eight `/internal/v1/*` namespaces the specification lists are the *action* paths, declared
 * in `@trustsystem/governance-tool-integration` and dispatched by `execute` below. They are not
 * separate controllers, because a namespace with its own controller is a namespace that
 * eventually grows its own auth.
 */
@ApiTags('Internal app gateway')
@ApiBearerAuth()
@Controller('internal/v1/apps')
export class GatewayController {
  constructor(
    @Inject(APP_CATALOG) private readonly catalog: InternalAppCatalog,
    @Inject(GOVERNANCE_RUNTIME) private readonly runtime: GovernanceToolRuntime,
    @Inject('GATEWAY_ENVIRONMENT') private readonly environment: Environment,
  ) {}

  private governanceActor(actor: ActorContext, organizationId: string): GovernanceActorContext {
    return {
      actorId: actor.userId,
      actorType: 'human',
      /*
       * From the verified actor, never from a header.
       *
       * `TenantGuard` resolved it against the membership tables before this handler ran. An
       * `X-Organization-Id` naming an organization is a request, not a fact, and there is no code
       * path here that reads one.
       */
      organizationId,
      roles: actor.roles ?? [],
      permissions: actor.permissions ?? [],
      /*
       * Narrowed rather than cast.
       *
       * `ActorContext.authentication` is absent for a machine actor, which has none — and the
       * honest reading of "absent" is the weakest level, not the strongest. Defaulting upward
       * here would let a service account satisfy an assurance check by not answering it.
       */
      authenticationLevel: authenticationLevelOf(actor),
      sessionId: actor.tokenId ?? null,
      issuer: 'trustos',
      displayName: null,
      email: null,
    };
  }

  @Get()
  @ApiOperation({ summary: 'The internal applications this actor may open' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  list(@CurrentUser() actor: ActorContext) {
    /*
     * Filtered by role membership, not merely listed.
     *
     * A catalog that showed every console and refused on open would tell somebody which consoles
     * exist — which is information they did not need, and occasionally should not have.
     */
    const roles = new Set(actor.roles ?? []);

    return {
      environment: this.environment,
      applications: this.catalog
        .list(this.environment)
        .filter((app) => app.roles.length === 0 || app.roles.some((role) => roles.has(role)))
        .map((app) => ({
          appId: app.appId,
          name: app.name,
          description: app.description,
          dataClassification: app.dataClassification,
          riskClassification: app.riskClassification,
        })),
    };
  }

  @Get(':appId')
  @ApiOperation({ summary: 'One application: its navigation, and what it is allowed to reach' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  get(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('appId') appId: string,
  ) {
    const app = this.catalog.require(this.environment, appId);

    return {
      app: {
        appId: app.appId,
        name: app.name,
        environment: app.environment,
        dataClassification: app.dataClassification,
      },
      navigation: this.runtime.navigationFor({
        actor: this.governanceActor(actor, organizationId),
        app,
        correlationId: 'navigation',
      }),
      /*
       * What this application can reach, derived from its definition.
       *
       * Returned on the same call a console loads with, so a security reviewer opening the
       * console sees the same summary the reviewer who approved it saw.
       */
      access: this.runtime.accessSummary(app),
    };
  }

  @Post(':appId/data/:dataSourceId')
  @ApiOperation({ summary: 'Read through a declared data source' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  async read(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('appId') appId: string,
    @Param('dataSourceId') dataSourceId: string,
    @Body() body: { filters?: Record<string, string | number | boolean>; limit?: number },
  ) {
    const app = this.catalog.require(this.environment, appId);

    const plan = await this.runtime.planRead(
      {
        actor: this.governanceActor(actor, organizationId),
        app,
        correlationId: correlationOf(actor),
      },
      dataSourceId,
      body.filters ?? {},
    );

    /*
     * The executor is the deployment's.
     *
     * This application ships none: it produces a plan and, in this example, returns it with an
     * empty result set. A gateway that shipped a query executor would ship a database client
     * pointed at production, which is the artefact this entire layer exists not to have.
     */
    const result = this.runtime.finishRead(plan, []);

    return {
      items: result.rows,
      nextCursor: null,
      maskedFields: result.maskedFields,
      droppedFields: result.droppedFields,
      plan: {
        resourceId: plan.resourceId,
        operation: plan.operation,
        fields: plan.fields,
        maxRows: plan.maxRows,
        /* Never the credential itself. The reference resolves in the deployment's secret store. */
        credentialRef: plan.credentialRef,
      },
    };
  }

  @Post(':appId/actions/:actionId')
  @ApiOperation({ summary: 'Perform a declared action through the TrustOS API behind it' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  async execute(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('appId') appId: string,
    @Param('actionId') actionId: string,
    @Body() body: { payload?: unknown; reason?: string; approvalRef?: string },
  ) {
    const app = this.catalog.require(this.environment, appId);

    const plan = await this.runtime.planMutation(
      {
        actor: this.governanceActor(actor, organizationId),
        app,
        correlationId: correlationOf(actor),
      },
      actionId,
      {
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.approvalRef ? { approvalRef: body.approvalRef } : {}),
      },
    );

    /*
     * The declared operation, checked again against the catalog.
     *
     * The runtime already refused an undeclared action and a non-gateway path. This asks the
     * separate question: is the path one TrustOS actually offers, and which API permission does
     * it need? A path that passes the first check and fails this one is an application declaring
     * an endpoint nobody built.
     */
    const operation = requireOperation('POST', plan.apiPath);

    return {
      accepted: true,
      /*
       * What *would* be called. This example forwards nothing.
       *
       * The deployment wires an HTTP client here, calling the TrustOS API with the actor's own
       * credential — never a service credential, because a gateway that called downstream as
       * itself would be a gateway through which everybody has the gateway's permissions.
       */
      forwardTo: {
        path: plan.apiPath,
        resourceId: plan.resourceId,
        operation: operation.operationId,
        apiPermission: operation.apiPermission,
        requiresIdempotencyKey: operation.createsRecord,
      },
    };
  }
}

/**
 * The actor's authentication strength, narrowed to the three the Governance Tool knows.
 *
 * Anything unrecognised — and absence — reads as `password`, the weakest. A machine actor has no
 * authentication strength at all, and treating that as `strong` is how a service account passes
 * a check meant for a person with a hardware key.
 */
function authenticationLevelOf(actor: ActorContext): 'password' | 'mfa' | 'strong' {
  const authentication = actor.authentication;
  if (!authentication) return 'password';

  if (authentication.level === 'high') return 'strong';
  if (authentication.level === 'medium' || authentication.mfa) return 'mfa';
  return 'password';
}

function correlationOf(actor: ActorContext): string {
  return (actor as { requestId?: string }).requestId ?? `cor_${actor.userId}`;
}
