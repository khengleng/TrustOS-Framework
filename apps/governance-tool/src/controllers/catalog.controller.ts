import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { HumanActorsOnly } from '@trustos/identity/nest';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { CrossOrganization, OrganizationId } from '@trustos/tenancy';
import {
  CONSOLE_TEMPLATES,
  GOVERNANCE_PERMISSIONS,
  findConsoleTemplate,
  validationStatusFor,
  parseInternalApplication,
  resourcesUsedBy,
  type Environment,
  type ApplicationEvidenceIndex,
  type InternalAppCatalog,
} from '@trustos/governance-tool-core';
import { planPromotion, type EnvironmentRegistry } from '@trustos/governance-environment-config';
import type { ResourceRegistry } from '@trustos/governance-resource-policy';
import { summarizeAccess } from '@trustos/governance-data-access';
import {
  APP_CATALOG,
  APPLICATION_EVIDENCE,
  ENVIRONMENT_REGISTRY,
  GATEWAY_ENVIRONMENT,
  RESOURCE_REGISTRY,
} from '../tokens';

/**
 * The internal application catalog.
 *
 * Section 30 of the specification asks for catalog metadata on every internal application, and
 * this is where a person reads it. The screen answers three questions, and the third is the one
 * that makes the catalog worth maintaining:
 *
 *   * what internal tools exist, and who owns them;
 *   * which of them are due a security review;
 *   * **which of them can reach a given resource** — the question asked during an incident, and
 *     unanswerable if a console's data sources are code.
 */
@ApiTags('Internal application catalog')
@ApiBearerAuth()
@Controller('governance/apps')
export class CatalogController {
  constructor(
    @Inject(APP_CATALOG) private readonly catalog: InternalAppCatalog,
    @Inject(RESOURCE_REGISTRY) private readonly resources: ResourceRegistry,
    @Inject(ENVIRONMENT_REGISTRY) private readonly environments: EnvironmentRegistry,
    @Inject(GATEWAY_ENVIRONMENT) private readonly environment: Environment,
    @Inject(APPLICATION_EVIDENCE) private readonly evidence: ApplicationEvidenceIndex,
  ) {}

  /*
   * Platform-level, not tenant data.
   *
   * The internal application catalog is keyed by environment and appId — there is no
   * organization column on it and `catalog.list()` takes no organization. Requiring a
   * tenant scope over data that has none meant these reads were refused for every
   * caller, including the platform staff they exist for.
   *
   * `CrossOrganization` is the framework's primitive for this and it is not a
   * loosening: TenantGuard refuses it outright unless the actor is `isSuperAdmin`, so
   * this narrows the audience to platform staff rather than widening it. The writes
   * below are deliberately left alone.
   */
  @Get()
  @CrossOrganization()
  @ApiOperation({ summary: 'Every registered internal application, with its catalog metadata' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  list() {
    return {
      environment: this.environment,
      applications: this.catalog.list(this.environment).map((app) => ({
        appId: app.appId,
        name: app.name,
        businessPurpose: app.businessPurpose,
        owner: app.owner,
        businessOwner: app.businessOwner,
        technicalOwner: app.technicalOwner,
        lifecycleStatus: app.lifecycleStatus,
        dataClassification: app.dataClassification,
        riskClassification: app.riskClassification,
        roles: app.roles,
        /* Derived, so it cannot drift from what the application actually declares. */
        resources: resourcesUsedBy(app),
        aiFeatures: app.aiFeatures,
        lastSecurityReview: app.lastSecurityReview,
        nextSecurityReview: app.nextSecurityReview,
        /*
         * Whether anything has actually been proven about this application.
         *
         * Derived rather than declared, and deliberately separate from
         * `lifecycleStatus`: a descriptor renders perfectly and proves nothing, so a
         * console that looks finished must not be mistaken for one that works.
         *
         * `not_tested` is the honest answer for every registered application today —
         * they are declarations, and nothing executes them. It is not `fail`, because
         * nothing is broken; there is simply nothing yet to break. It becomes something
         * else when an implementation exists and its tests run, not when somebody edits
         * a label.
         */
        validationStatus: validationStatusOf(app, this.evidence, this.environment),
      })),
    };
  }

  @Get('by-resource/:resourceId')
  @CrossOrganization()
  @ApiOperation({ summary: 'Which internal tools can reach a resource' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.RESOURCE_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.RESOURCE_READ.key)
  byResource(@Param('resourceId') resourceId: string) {
    /*
     * The incident question.
     *
     * "Which internal tools can see this data, and who approved that" is unanswerable if a
     * console's data sources are code — which is the reason they are a document.
     */
    return {
      resourceId,
      applications: this.catalog
        .list(this.environment)
        .filter((app) => resourcesUsedBy(app).includes(resourceId))
        .map((app) => ({
          appId: app.appId,
          name: app.name,
          owner: app.owner,
          mutates: app.actions.some((action) => action.resourceId === resourceId),
        })),
    };
  }

  @Get('reviews/overdue')
  @CrossOrganization()
  @ApiOperation({ summary: 'Applications and resources whose review has passed' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  overdue() {
    const now = new Date();

    return {
      applications: this.catalog
        .list(this.environment)
        .filter((app) => new Date(app.nextSecurityReview) < now)
        .map((app) => ({ appId: app.appId, nextSecurityReview: app.nextSecurityReview })),
      resources: this.resources.overdueReviews(this.environment, now).map((resource) => ({
        resourceId: resource.resourceId,
        nextReviewDate: resource.nextReviewDate,
      })),
    };
  }

  @Get('templates')
  @CrossOrganization()
  @ApiOperation({ summary: 'The ten console templates' })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  templates() {
    return {
      templates: CONSOLE_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
      })),
    };
  }

  @Get(':appId/access')
  @CrossOrganization()
  @ApiOperation({
    summary: 'What this application is allowed to reach — the security review screen',
  })
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_READ.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_READ.key)
  access(@Param('appId') appId: string) {
    const app = this.catalog.require(this.environment, appId);

    return summarizeAccess({
      appId: app.appId,
      environment: this.environment,
      registry: this.resources,
      dataSources: app.dataSources.map((source) => ({
        resourceId: source.resourceId,
        operation: source.operation,
      })),
      actions: app.actions.map((action) => ({
        resourceId: action.resourceId,
        operation: action.operation,
        apiPath: action.apiPath,
      })),
    });
  }

  @Post('from-template')
  @ApiOperation({ summary: 'Create a draft internal application from a console template' })
  @HumanActorsOnly()
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_CREATE.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_CREATE.key)
  fromTemplate(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body() body: { templateId: string; appId?: string },
  ) {
    void organizationId;
    const template = findConsoleTemplate(body.templateId);

    if (!template) {
      return { created: null, availableTemplates: CONSOLE_TEMPLATES.map((entry) => entry.id) };
    }

    /*
     * Always a draft, in the lowest environment, owned by whoever asked.
     *
     * A template that could be created directly into production would be a way to put a console
     * in front of production data without passing through the promotion that reviews it.
     */
    const draft = parseInternalApplication({
      ...template.build(),
      ...(body.appId ? { appId: body.appId } : {}),
      environment: 'dev',
      lifecycleStatus: 'draft',
      owner: actor.userId,
      lastSecurityReview: null,
    });

    return { created: this.catalog.register(draft) };
  }

  @Post(':appId/promotion/plan')
  @ApiOperation({ summary: 'Plan a promotion. Changes nothing.' })
  @HumanActorsOnly()
  @RequirePermissions(GOVERNANCE_PERMISSIONS.APP_PROMOTE.key)
  @Authorize(GOVERNANCE_PERMISSIONS.APP_PROMOTE.key)
  planPromotion(
    @Param('appId') appId: string,
    @Body()
    body: {
      toEnvironment: Environment;
      hasTestEvidence: boolean;
      securityReviewed: boolean;
      rollbackTarget: string | null;
    },
  ) {
    const app = this.catalog.require(this.environment, appId);

    const summary = summarizeAccess({
      appId: app.appId,
      environment: body.toEnvironment,
      registry: this.resources,
      dataSources: app.dataSources.map((source) => ({
        resourceId: source.resourceId,
        operation: source.operation,
      })),
      actions: app.actions.map((action) => ({
        resourceId: action.resourceId,
        operation: action.operation,
        apiPath: action.apiPath,
      })),
    });

    return planPromotion({
      appId: app.appId,
      appVersion: app.version,
      fromEnvironment: app.environment,
      toEnvironment: body.toEnvironment,
      registry: this.environments,
      /*
       * Resolved against the *target* environment.
       *
       * A resource registered in DEV and not in PROD is the commonest promotion failure, and
       * checking it against the source environment would report it as fine.
       */
      resourcesResolved: summary.unregistered.length === 0,
      unregisteredResources: summary.unregistered,
      hasTestEvidence: body.hasTestEvidence,
      securityReviewed: body.securityReviewed,
      rollbackTarget: body.rollbackTarget,
    });
  }
}

/**
 * The validation state of a registered application.
 *
 * An application is only more than `not_tested` once something executes it, and this now
 * reads the result of that execution rather than returning a constant. The rule it was
 * written to protect is unchanged: it is a function over evidence, not a field on a
 * descriptor, because a status field is a claim an application's author makes about
 * their own application and every such field eventually says "pass".
 *
 * Evidence is keyed by environment and is not promoted across environments. A pass in
 * DEV is a pass in DEV; asked about anything else, this says `not_tested`.
 */
function validationStatusOf(
  app: { appId: string },
  evidence: ApplicationEvidenceIndex,
  environment: string,
): 'not_tested' | 'partial' | 'pass' | 'fail' {
  return validationStatusFor(app.appId, evidence, environment);
}
