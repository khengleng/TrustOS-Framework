import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { ApiError } from '@trustos/errors';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { OrganizationId } from '@trustos/tenancy';
import type { AuditService } from '@trustos/audit';
import { classificationRank, obligationsFor } from '@trustos/data-classification';
import type { DataCatalog } from '@trustos/data-catalog';
import type { LineageGraph } from '@trustos/data-lineage';
import { AUDIT_SERVICE, DATA_CATALOG, LINEAGE_GRAPH } from '../tokens';
import { ENTERPRISE_PERMISSIONS } from '../permissions';

/**
 * Data governance: catalog, classification, lineage.
 *
 * Two things this controller does that a thinner one would not, both because the alternative is a
 * governance console that quietly widens access:
 *
 * **`authorized` is resolved from the actor, never from the request.** `DataCatalog.search` takes
 * an `authorized` flag that decides whether full metadata comes back or a stub. Accepting that as
 * a query parameter would make the whole classification model a suggestion — and it is exactly
 * the sort of parameter that gets added for a legitimate internal reason and then never removed.
 *
 * **Lowering a classification is audited as a separate action from raising one.** Both are
 * reclassifications and both need approval, but only one of them makes previously-restricted data
 * readable, and an audit trail where they share an action name cannot be searched for the one
 * that matters.
 */
@ApiTags('Data governance')
@ApiBearerAuth()
@Controller('enterprise/data')
export class DataGovernanceController {
  constructor(
    @Inject(DATA_CATALOG) private readonly catalog: DataCatalog,
    @Inject(LINEAGE_GRAPH) private readonly lineage: LineageGraph,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Search the data catalog' })
  @ApiOkResponse({
    description: 'Catalog entries, with metadata narrowed to what the caller may see.',
  })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.DATA_CATALOG_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.DATA_CATALOG_READ.key)
  search(
    @CurrentUser() actor: ActorContext,
    @Query('text') text?: string,
    @Query('kind') kind?: string,
    @Query('classification') classification?: string,
    @Query('domain') domain?: string,
  ) {
    /*
     * Resolved here, from permissions the guards already verified. A caller can ask for anything
     * in the query string; what they get back is decided by what they hold.
     */
    const authorized = (actor.permissions ?? []).includes(
      ENTERPRISE_PERMISSIONS.DATA_CATALOG_READ.key,
    );

    return {
      entries: this.catalog.search({
        authorized,
        ...(text ? { text } : {}),
        ...(kind ? { kind: kind as never } : {}),
        ...(classification ? { classification: classification as never } : {}),
        ...(domain ? { domain } : {}),
      }),
    };
  }

  @Get('catalog/:entryId')
  @ApiOperation({ summary: 'One catalog entry, with its inherited classification' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.DATA_CATALOG_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.DATA_CATALOG_READ.key)
  get(@Param('entryId') entryId: string) {
    const entry = this.catalog.require(entryId);
    const inherited = this.catalog.inheritedClassification(entryId);

    return {
      entry,
      /*
       * The declared classification and the one its children imply, side by side. A table
       * classified INTERNAL whose columns are RESTRICTED is the common case, and it is invisible
       * from the entry alone.
       */
      inheritedClassification: inherited,
      classificationIsUnderstated:
        classificationRank(inherited) > classificationRank(entry.classification),
      obligations: obligationsFor(inherited),
      children: this.catalog.children(entryId).map((child) => child.entryId),
    };
  }

  @Get('findings')
  @ApiOperation({ summary: 'Entries whose classification is below what their contents imply' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.DATA_CATALOG_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.DATA_CATALOG_READ.key)
  findings() {
    return {
      misclassified: this.catalog.misclassified(),
      overdueReviews: this.catalog.overdueReviews(new Date()).map((entry) => entry.entryId),
      lineageDrift: this.lineage.classificationDrift(this.catalog),
    };
  }

  @Get('lineage/:entryId')
  @ApiOperation({ summary: 'What this entry came from and what it feeds' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.DATA_LINEAGE_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.DATA_LINEAGE_READ.key)
  lineageOf(@Param('entryId') entryId: string) {
    this.catalog.require(entryId);

    return {
      upstream: this.lineage.upstreamOf(entryId),
      downstream: this.lineage.downstreamOf(entryId),
      propagatedClassification: this.lineage.propagatedClassification(entryId, this.catalog),
      edgesIn: this.lineage.edgesTo(entryId),
      edgesOut: this.lineage.edgesFrom(entryId),
    };
  }

  @Post('catalog/:entryId/classification')
  @ApiOperation({ summary: 'Propose a classification change' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.DATA_CLASSIFY.key)
  @Authorize(ENTERPRISE_PERMISSIONS.DATA_CLASSIFY.key)
  async propose(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('entryId') entryId: string,
    @Body() body: { classification: string; reason: string },
  ) {
    const entry = this.catalog.require(entryId);

    if (!body.reason || body.reason.trim().length < 20) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'Say why the classification is wrong.' }],
        'A reclassification without a reason cannot be reviewed.',
      );
    }

    const lowering =
      classificationRank(body.classification as never) < classificationRank(entry.classification);

    /*
     * Proposed, not applied. The approval is a second permission held by a second person — see
     * SEGREGATED_PAIRS. This route deliberately returns a proposal rather than mutating the
     * catalog, because a classification a proposer can apply is not a classification anybody
     * reviews.
     */
    await this.audit.record({
      action: lowering
        ? 'enterprise.data.classification.lowering_proposed'
        : 'enterprise.data.classification.raising_proposed',
      entityType: 'catalog_entry',
      entityId: entryId,
      actorId: actor.userId,
      organizationId,
      before: { classification: entry.classification },
      after: { classification: body.classification },
      metadata: { reason: body.reason, lowering },
    });

    return {
      status: 'proposed',
      entryId,
      from: entry.classification,
      to: body.classification,
      lowering,
      requiresApprovalBy: ENTERPRISE_PERMISSIONS.DATA_CLASSIFY_APPROVE.key,
      note: lowering
        ? 'This lowers the classification, so data previously masked or restricted becomes readable. It is recorded as a distinct action for that reason.'
        : 'This raises the classification. Existing access may need review against the higher level.',
    };
  }
}
