import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { ApiError } from '@trustos/errors';
import { RequirePermissions } from '@trustos/rbac';
import type { ActorContext } from '@trustos/shared-types';
import { OrganizationId } from '@trustos/tenancy';
import type { AuditService } from '@trustos/audit';
import { policyDocumentSchema, type PolicyRegistry } from '@trustos/policy-registry';
import type { PolicyEngine } from '@trustos/policy-engine';
import { AUDIT_SERVICE, POLICY_ENGINE, POLICY_REGISTRY } from '../tokens';
import { ENTERPRISE_PERMISSIONS } from '../permissions';

/**
 * The policy registry, simulator and approvals.
 *
 * The console surface for policy-as-code, and the place where the difference between simulating
 * and deciding has to be visible in the URL rather than in a flag.
 *
 * `POST /simulate` evaluates any policy, including a draft, and records nothing. `POST /decide`
 * evaluates only an active policy, records every outcome, and enforces. Making them one route
 * with a `dryRun` parameter would be smaller code and a worse system: the parameter defaults
 * somewhere, and a mistake in the default is either an unrecorded decision or an enforced draft.
 *
 * There is no route that edits an active policy version. Versions are immutable in the registry,
 * and a console route that could edit one would make every decision record unre-derivable — the
 * log would name a version whose contents had since changed.
 */
@ApiTags('Policy')
@ApiBearerAuth()
@Controller('enterprise/policies')
export class PolicyController {
  constructor(
    @Inject(POLICY_REGISTRY) private readonly registry: PolicyRegistry,
    @Inject(POLICY_ENGINE) private readonly engine: PolicyEngine,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List policies' })
  @ApiOkResponse({ description: 'Policy documents, newest version of each first.' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.POLICY_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.POLICY_READ.key)
  list(@Query('category') category?: string) {
    const policies = category ? this.registry.byCategory(category as never) : [];

    return {
      policies: policies.map((policy) => ({
        policyId: policy.policyId,
        name: policy.name,
        version: policy.version,
        status: policy.status,
        category: policy.category,
        owner: policy.owner,
        reviewDate: policy.reviewDate,
      })),
      overdueReviews: this.registry.overdueReviews(new Date()).map((policy) => ({
        policyId: policy.policyId,
        version: policy.version,
        reviewDate: policy.reviewDate,
      })),
      total: this.registry.size(),
    };
  }

  @Get(':policyId/versions')
  @ApiOperation({ summary: 'Every version of a policy' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.POLICY_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.POLICY_READ.key)
  versions(@Param('policyId') policyId: string) {
    const versions = this.registry.versionsOf(policyId);
    if (versions.length === 0) throw ApiError.notFound(`No policy called ${policyId}.`);

    return { policyId, versions };
  }

  @Post('simulate')
  @ApiOperation({ summary: 'Evaluate a policy without enforcing or recording it' })
  @ApiOkResponse({ description: 'The decision, with the full evaluation trace.' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.POLICY_SIMULATE.key)
  @Authorize(ENTERPRISE_PERMISSIONS.POLICY_SIMULATE.key)
  simulate(
    @Body() body: { policyId: string; policyVersion?: string; attributes: Record<string, never> },
  ) {
    /*
     * Drafts included. Simulating a policy that is not yet in force is the entire point — a policy
     * whose behaviour can only be observed after activation is a policy nobody can review.
     */
    return this.engine.simulate({
      policyId: body.policyId,
      ...(body.policyVersion ? { policyVersion: body.policyVersion } : {}),
      attributes: body.attributes ?? {},
    });
  }

  @Post('decide')
  @ApiOperation({ summary: 'Decide, enforce and record' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.POLICY_READ.key)
  @Authorize(ENTERPRISE_PERMISSIONS.POLICY_READ.key)
  async decide(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body()
    body: {
      policyId: string;
      policyVersion?: string;
      attributes: Record<string, never>;
      action: string;
      correlationId: string;
    },
  ) {
    // Refuses a non-active policy, so a draft cannot take effect through this route.
    return this.engine.decide({
      policyId: body.policyId,
      ...(body.policyVersion ? { policyVersion: body.policyVersion } : {}),
      attributes: body.attributes ?? {},
      actorId: actor.userId,
      organizationId,
      action: body.action,
      correlationId: body.correlationId,
    });
  }

  @Post('validate')
  @ApiOperation({ summary: 'Check a draft policy before it is proposed for activation' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.POLICY_AUTHOR.key)
  @Authorize(ENTERPRISE_PERMISSIONS.POLICY_AUTHOR.key)
  validate(@Body() body: unknown) {
    const policy = policyDocumentSchema.parse(body);
    return { policyId: policy.policyId, version: policy.version, ...this.engine.validate(policy) };
  }

  @Post(':policyId/versions/:version/activate')
  @ApiOperation({ summary: 'Activate a version somebody else authored' })
  @RequirePermissions(ENTERPRISE_PERMISSIONS.POLICY_ACTIVATE.key)
  @Authorize(ENTERPRISE_PERMISSIONS.POLICY_ACTIVATE.key)
  async activate(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('policyId') policyId: string,
    @Param('version') version: string,
    @Body() body: { reason: string },
  ) {
    const policy = this.registry.require(policyId, version);

    /*
     * The author cannot activate their own policy.
     *
     * A policy is a rule that governs everybody else's behaviour. One person writing and enacting
     * it is unreviewed rule-making, and it is the same separation the framework applies to
     * financial approvals — the fact that this one produces no journal entry does not make it
     * smaller.
     */
    if (policy.owner === actor.userId) {
      throw ApiError.forbidden(
        'The author of a policy does not activate it. A policy governs everybody else, and one person writing and enacting it is unreviewed rule-making.',
        { reason: 'self_activation', policyId, version },
      );
    }

    const validation = this.engine.validate(policy);

    if (!validation.valid) {
      throw ApiError.conflict(
        'This policy version does not pass its own tests or static analysis.',
        {
          findings: validation.findings.map((finding) => `${finding.ruleId}: ${finding.message}`),
          failingTests: validation.tests.results
            .filter((result) => !result.passed)
            .map((result) => result.name),
        },
      );
    }

    await this.audit.record({
      action: 'enterprise.policy.activated',
      entityType: 'policy',
      entityId: `${policyId}@${version}`,
      actorId: actor.userId,
      organizationId,
      before: { status: policy.status },
      after: { status: 'active' },
      metadata: { reason: body.reason, author: policy.owner },
    });

    return {
      status: 'activation_recorded',
      policyId,
      version,
      author: policy.owner,
      activatedBy: actor.userId,
      note: 'The registry holds versions immutably; the deployment applies the status change through its own store.',
    };
  }
}
