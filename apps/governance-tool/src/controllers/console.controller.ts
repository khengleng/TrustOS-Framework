import { Controller, Get, Inject, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { OrganizationId } from '@trustos/tenancy';
import { DEFAULT_MASK_RULES, type MaskRule } from '@trustos/governance-pii-policy';
import { DEFAULT_EXPORT_POLICIES } from '@trustos/governance-export-control';
import {
  GOVERNANCE_PERMISSIONS,
  GOVERNANCE_ROLES,
  type Environment,
  type InternalAppCatalog,
} from '@trustos/governance-tool-core';
import { GATEWAY_OPERATIONS } from '@trustos/governance-tool-integration';
import type { GovernanceToolRuntime } from '@trustos/governance-tool-runtime';
import { APP_CATALOG, GATEWAY_ENVIRONMENT, GOVERNANCE_RUNTIME } from '../tokens';

/**
 * What a console needs to render itself.
 *
 * Pages, the actions on each, which fields are masked and where a reveal is possible, and what
 * an export of this data would cost in approvals. All of it **descriptors**, none of it data —
 * the data comes through the gateway.
 *
 * The split is worth stating because it looks like an extra hop. A console that fetched its
 * definition from the same place it fetched its rows would be a console whose definition arrives
 * through a path that also carries production data, and the two have very different review
 * requirements. Here the descriptors are public to anybody who can open the tool and the rows
 * are not.
 */
@ApiTags('Consoles')
@ApiBearerAuth()
@Controller('governance/consoles')
export class ConsoleController {
  constructor(
    @Inject(APP_CATALOG) private readonly catalog: InternalAppCatalog,
    @Inject(GOVERNANCE_RUNTIME) private readonly runtime: GovernanceToolRuntime,
    @Inject(GATEWAY_ENVIRONMENT) private readonly environment: Environment,
  ) {}

  @Get(':appId')
  @ApiOperation({ summary: 'The console a specific person sees' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  console(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('appId') appId: string,
  ) {
    const app = this.catalog.require(this.environment, appId);

    const governanceActor = {
      actorId: actor.userId,
      actorType: 'human' as const,
      organizationId,
      roles: actor.roles ?? [],
      permissions: actor.permissions ?? [],
      authenticationLevel: 'password' as const,
      sessionId: actor.tokenId ?? null,
      issuer: 'trustos',
      displayName: null,
      email: null,
    };

    return {
      app: { appId: app.appId, name: app.name, environment: app.environment },
      /*
       * Pages the actor cannot open are **omitted**, not disabled.
       *
       * A disabled navigation entry tells somebody a console exists and that they cannot open
       * it, which is information they did not need. Actions are the opposite — disabled with a
       * reason, because a page is a place and an action is a decision.
       */
      navigation: this.runtime.navigationFor({
        actor: governanceActor,
        app,
        correlationId: 'console',
      }),
      pages: app.pages
        .filter((page) => governanceActor.permissions.includes(page.permission))
        .map((page) => ({
          id: page.id,
          title: page.title,
          components: page.components.map((component) => ({
            ...component,
            actions: component.actionIds
              .map((actionId) => app.actions.find((action) => action.id === actionId))
              .filter((action): action is NonNullable<typeof action> => action !== undefined)
              .map((action) => ({
                id: action.id,
                label: action.label,
                requiresReason: action.requiresReason,
                requiresApproval: action.requiresApproval,
                reversible: action.reversible,
                enabled: governanceActor.permissions.includes(action.permission),
                /* Shown beside a disabled control. It teaches the rule at the right moment. */
                disabledReason: governanceActor.permissions.includes(action.permission)
                  ? null
                  : `You do not have "${action.permission}" in the Governance Tool.`,
              })),
          })),
        })),
    };
  }

  @Get(':appId/masking')
  @ApiOperation({ summary: 'Which fields are masked, and which can be revealed' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  masking(@Param('appId') appId: string) {
    const app = this.catalog.require(this.environment, appId);
    const declared = new Set(app.dataSources.flatMap((source) => source.fields));

    return {
      appId,
      rules: DEFAULT_MASK_RULES.filter((rule: MaskRule) => declared.has(rule.field)).map(
        (rule) => ({
          field: rule.field,
          strategy: rule.strategy,
          revealable: rule.revealable,
          revealRequiresApproval: rule.revealRequiresApproval,
          description: rule.description ?? null,
        }),
      ),
      /* Fifteen minutes. A granted reveal is not a standing grant. */
      maxRevealWindowMinutes: 15,
    };
  }

  @Get(':appId/export-policy')
  @ApiOperation({ summary: 'What an export of this application’s data would need' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.EXPORT_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.EXPORT_READ.key)
  exportPolicy(@Param('appId') appId: string) {
    const app = this.catalog.require(this.environment, appId);
    const policy = DEFAULT_EXPORT_POLICIES[app.dataClassification];

    return {
      appId,
      classification: app.dataClassification,
      maxRows: policy.maxRows,
      approvalAboveRows: policy.approvalAboveRows,
      requiresJustification: policy.requiresJustification,
      maskFields: policy.maskFields,
      watermark: policy.watermark,
      expiryHours: policy.expiryHours,
    };
  }

  @Get('reference/operations')
  @ApiOperation({ summary: 'Every gateway operation, and the API permission each one needs' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.RESOURCE_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.RESOURCE_READ.key)
  operations() {
    return {
      operations: GATEWAY_OPERATIONS.map((operation) => ({
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        resourceId: operation.resourceId,
        apiPermission: operation.apiPermission,
        createsRecord: operation.createsRecord,
        description: operation.description,
      })),
    };
  }

  @Get('reference/roles')
  @ApiOperation({ summary: 'The ten internal roles and what each one sees' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  roles() {
    return { roles: GOVERNANCE_ROLES };
  }
}
