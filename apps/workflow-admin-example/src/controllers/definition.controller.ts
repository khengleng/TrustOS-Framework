import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { HumanActorsOnly } from '@trustsystem/identity/nest';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { OrganizationId } from '@trustsystem/tenancy';
import { z } from '@trustsystem/validation';
import { ZodValidationPipe } from '@trustsystem/validation/nest';
import { toWorkflowActor, WORKFLOW_PERMISSIONS } from '@trustsystem/workflow-core';
import {
  describeDefinitionConditions,
  formatComparison,
  simulateDefinition,
} from '@trustsystem/workflow-definition';
import {
  DEFINITION_LIFECYCLE,
  type WorkflowDefinitionService,
} from '@trustsystem/workflow-runtime';
import { WORKFLOW_DEFINITION_SERVICE } from '../tokens';

/*
 * Request schemas.
 *
 * Declared above the controller rather than below it. A `const` referenced inside a
 * parameter decorator is evaluated when the class is defined, not when the method runs, so a
 * schema declared afterwards is a temporal dead zone error at class-definition time — which
 * TypeScript reports and which is easy to introduce by writing the routes first.
 */
/**
 * The reviewer's summary.
 *
 * Two things a JSON document does not show: the paths that reach approval with no review at
 * all, and the conditions rendered as sentences. Both are what an approver actually needs,
 * and computing them here means the portal cannot get them subtly wrong.
 */
function summariseForReview(document: unknown): {
  paths: number;
  unapprovedPaths: string[];
  deadEnds: string[];
  separationOfDutyConcerns: string[];
  conditions: Array<{ path: string; condition: string }>;
} {
  const simulation = simulateDefinition(document);

  return {
    paths: simulation.paths.length,
    unapprovedPaths: simulation.unapprovedPaths.map((path) => path.states.join(' -> ')),
    deadEnds: simulation.deadEnds,
    separationOfDutyConcerns: simulation.separationOfDutyConcerns,
    conditions:
      simulation.valid && simulation.paths.length > 0
        ? describeDefinitionConditions(
            // Safe: `simulateDefinition` only reports paths for a document that parsed.
            (simulation as unknown as { document?: never }).document ??
              (document as Parameters<typeof describeDefinitionConditions>[0]),
          )
        : [],
  };
}

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const draftSchema = z.object({
  /**
   * The definition document, unparsed.
   *
   * `unknown` rather than a mirrored schema. The definition schema lives in
   * `@trustsystem/workflow-definition` and validating here as well would be two schemas to keep
   * in step — and the second one would drift.
   */
  document: z.unknown(),
  scope: z.enum(['organization', 'global']).optional(),
});

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() });
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const publishSchema = z.object({
  effectiveFrom: z.coerce.date().optional(),
  retirePrevious: z.boolean().optional(),
});

const compareSchema = z.object({
  fromVersionId: z.string().min(1).max(64),
  toVersionId: z.string().min(1).max(64),
});

/**
 * Workflow definitions and their governance.
 *
 * Forms and structured configuration, not a visual designer — a drag-and-drop canvas is
 * explicitly out of scope for this phase, and a definition that is JSON in a text area is
 * reviewable in a diff, which a canvas is not.
 *
 * The three governance routes — submit, approve, publish — are three different grants held
 * by three different people, and `definitionGovernancePolicy` enforces that they are three
 * different *people* rather than three roles one person happens to hold. That is the control
 * that stops the whole engine being circumvented: somebody who can author and publish can
 * ship `allowSelfApproval: true` and approve their own requests through it.
 *
 * `@HumanActorsOnly()` throughout. A machine that can publish a workflow definition can
 * publish one that lets it approve its own work.
 */
@ApiTags('workflow/definitions')
@ApiBearerAuth('access-token')
@HumanActorsOnly()
@Controller('workflow/definitions')
export class DefinitionController {
  constructor(
    @Inject(WORKFLOW_DEFINITION_SERVICE) private readonly definitions: WorkflowDefinitionService,
  ) {}

  @Get()
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_READ.key)
  @Authorize('workflow.definition.read', 'WorkflowDefinition')
  @ApiOperation({ summary: 'List workflow definitions available to this organization' })
  @ApiOkResponse({ description: 'The organization’s own definitions, plus platform-owned ones.' })
  list(
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    return this.definitions.list(toWorkflowActor(actor), query);
  }

  @Get('lifecycle')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_READ.key)
  @ApiOperation({ summary: 'The definition lifecycle, and who may perform each step' })
  @ApiOkResponse({
    description:
      'Rendered by the portal so an administrator can see the governance model without ' +
      'reading the code.',
  })
  lifecycle() {
    return DEFINITION_LIFECYCLE;
  }

  @Get(':definitionId/versions')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_READ.key)
  @Authorize('workflow.definition.read', 'WorkflowDefinition')
  @ApiOperation({ summary: 'Every version of a definition, with its governance record' })
  versions(@CurrentUser() actor: ActorContext, @Param('definitionId') definitionId: string) {
    return this.definitions.listVersions(toWorkflowActor(actor), definitionId);
  }

  @Post('drafts')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_CREATE.key)
  @Authorize('workflow.definition.create', 'WorkflowVersion')
  @ApiOperation({ summary: 'Create a draft definition, or a new draft version' })
  @ApiOkResponse({
    description:
      'Structural errors are refused even in draft. Warnings are returned and must be seen ' +
      'before approval — `allowSelfApproval` is the one that matters.',
  })
  async createDraft(
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(draftSchema)) body: z.infer<typeof draftSchema>,
  ) {
    const result = await this.definitions.createDraft(toWorkflowActor(actor), {
      document: body.document,
      ...(body.scope ? { scope: body.scope } : {}),
    });

    return {
      definition: result.definition,
      version: result.version,
      findings: result.findings,
      // The reviewer's view, computed on the way out so the portal does not have to
      // re-derive it. This is what makes "is there a path to approved with no review" a
      // visible answer rather than a reading exercise.
      analysis: summariseForReview(body.document),
    };
  }

  @Post('versions/:versionId')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_UPDATE.key)
  @Authorize('workflow.definition.update', 'WorkflowVersion')
  @ApiOperation({ summary: 'Edit a draft. Refused once the version is under review.' })
  async updateDraft(
    @CurrentUser() actor: ActorContext,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(draftSchema)) body: z.infer<typeof draftSchema>,
  ) {
    const result = await this.definitions.updateDraft(toWorkflowActor(actor), {
      versionId,
      document: body.document,
    });

    return {
      version: result.version,
      findings: result.findings,
      analysis: summariseForReview(body.document),
    };
  }

  @Post('versions/:versionId/submit')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_SUBMIT.key)
  @Authorize('workflow.definition.submit', 'WorkflowVersion')
  @ApiOperation({ summary: 'Submit a draft for independent approval' })
  @ApiOkResponse({
    description: 'Editing stops here, so a reviewer reads a document that cannot change.',
  })
  submit(@CurrentUser() actor: ActorContext, @Param('versionId') versionId: string) {
    return this.definitions.submitForApproval(toWorkflowActor(actor), versionId);
  }

  @Post('versions/:versionId/withdraw')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_UPDATE.key)
  @Authorize('workflow.definition.update', 'WorkflowVersion')
  @ApiOperation({ summary: 'Withdraw a submission so the author can edit again' })
  @ApiOkResponse({
    description:
      'Clears any approval: a withdrawn-and-reworked version carrying its previous approval ' +
      'would be a definition approved in one form and published in another.',
  })
  withdraw(@CurrentUser() actor: ActorContext, @Param('versionId') versionId: string) {
    return this.definitions.withdraw(toWorkflowActor(actor), versionId);
  }

  @Post('versions/:versionId/approve')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_APPROVE.key)
  @Authorize('workflow.definition.approve', 'WorkflowVersion')
  @ApiOperation({ summary: 'Approve a version somebody else authored' })
  @ApiOkResponse({
    description:
      'Refused for the author. The warnings present at approval are recorded, so a warning ' +
      'that is absent later means the definition changed.',
  })
  approve(
    @CurrentUser() actor: ActorContext,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(noteSchema)) body: z.infer<typeof noteSchema>,
  ) {
    return this.definitions.approve(toWorkflowActor(actor), versionId, body.note);
  }

  @Post('versions/:versionId/publish')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_PUBLISH.key)
  @Authorize('workflow.definition.publish', 'WorkflowVersion')
  @ApiOperation({ summary: 'Publish an approved version' })
  @ApiOkResponse({
    description:
      'The version becomes immutable and new instances use it. Existing instances keep the ' +
      'version they started on — they are never migrated.',
  })
  publish(
    @CurrentUser() actor: ActorContext,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(publishSchema)) body: z.infer<typeof publishSchema>,
  ) {
    return this.definitions.publish(toWorkflowActor(actor), versionId, {
      ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom } : {}),
      ...(body.retirePrevious !== undefined ? { retirePrevious: body.retirePrevious } : {}),
    });
  }

  @Post('versions/:versionId/retire')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_RETIRE.key)
  @Authorize('workflow.definition.retire', 'WorkflowVersion')
  @ApiOperation({ summary: 'Retire a version so no new instances use it' })
  @ApiOkResponse({
    description:
      'Reports how many instances are still running on it. Running instances continue — ' +
      'retirement stops new ones only.',
  })
  retire(
    @CurrentUser() actor: ActorContext,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.definitions.retire(toWorkflowActor(actor), versionId, body.reason);
  }

  @Post('versions/:versionId/rollback')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_PUBLISH.key)
  @Authorize('workflow.definition.publish', 'WorkflowVersion')
  @ApiOperation({ summary: 'Activate a previously approved version' })
  @ApiOkResponse({
    description:
      'Republishing, not editing history. The old version keeps its original approval record ' +
      'and the second publication is its own event.',
  })
  rollback(
    @CurrentUser() actor: ActorContext,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.definitions.rollbackTo(toWorkflowActor(actor), versionId, body.reason);
  }

  @Get('versions/compare')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_READ.key)
  @ApiOperation({ summary: 'Compare two versions, worst news first' })
  @ApiOkResponse({
    description:
      'Organised by consequence rather than by field: control weakening is its own bucket, ' +
      'because it is a governance question rather than an engineering one.',
  })
  async compare(
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(compareSchema)) query: z.infer<typeof compareSchema>,
  ) {
    const result = await this.definitions.compare(toWorkflowActor(actor), query);

    return {
      comparison: result.comparison,
      suggestedVersion: result.suggestedVersion,
      // Rendered, because an approver reads prose and not a nested object.
      rendered: formatComparison(result.comparison),
    };
  }

  @Post('simulate')
  @RequirePermissions(WORKFLOW_PERMISSIONS.DEFINITION_READ.key)
  @ApiOperation({ summary: 'Walk every path through a candidate definition' })
  @ApiOkResponse({
    description:
      'Static analysis only. No instance is created, nothing is written, and no notification ' +
      'is sent — so this is safe to run against a production definition.',
  })
  simulate(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(draftSchema)) body: z.infer<typeof draftSchema>,
  ) {
    void organizationId;
    return simulateDefinition(body.document);
  }
}
