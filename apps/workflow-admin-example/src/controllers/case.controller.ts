import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustsystem/authorization/nest';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import type { ActorContext } from '@trustsystem/shared-types';
import { z } from '@trustsystem/validation';
import { ZodValidationPipe } from '@trustsystem/validation/nest';
import {
  actorHasPermission,
  toWorkflowActor,
  WORKFLOW_PERMISSIONS,
  type CaseStatus,
} from '@trustsystem/workflow-core';
import type { CaseService } from '@trustsystem/case-management';
import {
  describeEvent,
  visibleCommentLevels,
  type AttachmentService,
  type CommentService,
} from '@trustsystem/workflow-history';
import { ATTACHMENT_SERVICE, CASE_SERVICE, COMMENT_SERVICE } from '../tokens';

/*
 * Request schemas.
 *
 * Declared above the controller rather than below it. A `const` referenced inside a
 * parameter decorator is evaluated when the class is defined, not when the method runs, so a
 * schema declared afterwards is a temporal dead zone error at class-definition time — which
 * TypeScript reports and which is easy to introduce by writing the routes first.
 */
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const listSchema = pageSchema.extend({
  status: z.string().max(200).optional(),
  caseType: z.string().max(200).optional(),
  ownerId: z.string().max(64).optional(),
  assignedTeam: z.string().max(120).optional(),
});

const openSchema = z.object({
  caseType: z.string().trim().min(1).max(80),
  subject: z.string().trim().min(1).max(300),
  description: z.string().trim().max(4000).default(''),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  ownerId: z.string().trim().min(1).max(64).nullable().optional(),
  assignedTeam: z.string().trim().min(1).max(120).nullable().optional(),
  businessObjectType: z.string().trim().min(1).max(120).nullable().optional(),
  businessObjectId: z.string().trim().min(1).max(64).nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

const updateSchema = z.object({
  expectedVersion: z.number().int().min(0).optional(),
  ownerId: z.string().trim().min(1).max(64).nullable().optional(),
  assignedTeam: z.string().trim().min(1).max(120).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  subject: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(4000).optional(),
});

const statusSchema = z.object({
  to: z.enum(['open', 'under_review', 'waiting_for_information', 'escalated', 'cancelled']),
  reason: z.string().trim().max(500).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

const resolveSchema = z.object({
  resolutionCode: z.string().trim().min(1).max(80),
  resolution: z.string().trim().min(1).max(4000),
  expectedVersion: z.number().int().min(0).optional(),
});

const closeSchema = z.object({
  closureReason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().min(0).optional(),
});

const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const commentSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  visibility: z
    .enum(['participants', 'approvers', 'administrators', 'internal', 'external'])
    .default('participants'),
  stepKey: z.string().trim().min(1).max(80).optional(),
});

const amendSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  reason: z.string().trim().min(3).max(500),
});

const attachSchema = z.object({
  documentId: z.string().trim().min(1).max(64),
  classification: z
    .enum([
      'supporting_evidence',
      'identity_document',
      'financial_record',
      'correspondence',
      'internal_analysis',
      'other',
    ])
    .default('other'),
  stepKey: z.string().trim().min(1).max(80).optional(),
});

/**
 * Cases: the container a workflow runs inside.
 *
 * The routes mirror the one tight rule in the model: `resolve` and `close` are separate,
 * and closing requires a prior resolution. Collapsing them into one route would lose the
 * distinction that matters — the person who decides what to do about a complaint is often
 * not the person who confirms it was actioned.
 *
 * The comment routes compute the reader's visibility **server-side** from their permissions.
 * A client-supplied visibility filter would be a way to ask for `internal` comments and be
 * given them.
 */
@ApiTags('cases')
@ApiBearerAuth('access-token')
@Controller('cases')
export class CaseController {
  constructor(
    @Inject(CASE_SERVICE) private readonly cases: CaseService,
    @Inject(COMMENT_SERVICE) private readonly comments: CommentService,
    @Inject(ATTACHMENT_SERVICE) private readonly attachments: AttachmentService,
  ) {}

  @Get()
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_READ.key)
  @Authorize('case.read', 'CaseRecord')
  @ApiOperation({ summary: 'The case queue' })
  @ApiOkResponse({
    description: 'Most urgent, closest to its deadline, first — not oldest first.',
  })
  list(
    @CurrentUser() actor: ActorContext,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ) {
    return this.cases.list(toWorkflowActor(actor), {
      ...(query.status ? { status: query.status.split(',') as CaseStatus[] } : {}),
      ...(query.caseType ? { caseType: query.caseType.split(',') } : {}),
      ...(query.ownerId ? { ownerId: query.ownerId } : {}),
      ...(query.assignedTeam ? { assignedTeam: query.assignedTeam } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('summary')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_READ.key)
  @ApiOperation({ summary: 'Case counts by status, for a dashboard tile' })
  @ApiOkResponse({
    description:
      'A grouped count rather than a page walk: producing "18 open, 4 escalated" by reading ' +
      'every case is the query that makes a dashboard slow at real volume.',
  })
  summary(@CurrentUser() actor: ActorContext) {
    return this.cases.countByStatus(toWorkflowActor(actor));
  }

  @Get(':caseId')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_READ.key)
  @Authorize('case.read', 'CaseRecord')
  @ApiOperation({ summary: 'One case, with its workflows and attachments' })
  async find(@CurrentUser() actor: ActorContext, @Param('caseId') caseId: string) {
    const workflowActor = toWorkflowActor(actor);

    const [record, instances, attachments] = await Promise.all([
      this.cases.find(workflowActor, caseId),
      this.cases.instances(workflowActor, caseId),
      this.attachments.list(workflowActor, { caseId }),
    ]);

    return { case: record, workflowInstances: instances, attachments };
  }

  @Get(':caseId/timeline')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_READ.key)
  @Authorize('case.read', 'CaseRecord')
  @ApiOperation({ summary: 'The case timeline, including its workflows’ events' })
  @ApiOkResponse({
    description:
      'One trail, so a case and the workflows inside it are ordered against each other. Two ' +
      'trails would need merging by timestamp, which is what the sequence number avoids.',
  })
  async timeline(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    const workflowActor = toWorkflowActor(actor);
    // Scoped by the read: a case in another organization is not found, so its timeline
    // cannot be reached by id.
    await this.cases.find(workflowActor, caseId);

    const page = await this.cases.timeline(workflowActor, caseId, query);

    return {
      ...page,
      items: page.items.map((event) => ({ ...event, description: describeEvent(event) })),
    };
  }

  @Post()
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_CREATE.key)
  @Authorize('case.create', 'CaseRecord')
  @ApiOperation({ summary: 'Open a case' })
  @ApiOkResponse({
    description:
      'Unowned by default. An owner assigned to whoever happened to open it is an owner ' +
      'nobody chose.',
  })
  open(
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>,
  ) {
    return this.cases.open(toWorkflowActor(actor), body);
  }

  @Post(':caseId')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_UPDATE.key)
  @Authorize('case.update', 'CaseRecord')
  @ApiOperation({ summary: 'Update owner, team, priority, due date, subject or description' })
  @ApiOkResponse({
    description:
      'Deliberately not the status: a generic update that also moved the status would let a ' +
      'status change happen without validation or a history entry.',
  })
  update(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.cases.update(toWorkflowActor(actor), caseId, body);
  }

  @Post(':caseId/status')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_UPDATE.key)
  @Authorize('case.update', 'CaseRecord')
  @ApiOperation({ summary: 'Move a case between statuses' })
  @ApiOkResponse({
    description:
      'Requires a reason for waiting_for_information and escalated — "waiting for what?" and ' +
      '"escalated why?" are the questions a reader asks.',
  })
  changeStatus(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.cases.changeStatus(toWorkflowActor(actor), caseId, body);
  }

  @Post(':caseId/resolve')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_RESOLVE.key)
  @Authorize('case.resolve', 'CaseRecord')
  @ApiOperation({ summary: 'Record a resolution' })
  @ApiOkResponse({
    description:
      'A code and a narrative. The code makes cases countable; the narrative is what somebody ' +
      'reads when the same customer complains again. Either alone is insufficient.',
  })
  resolve(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(resolveSchema)) body: z.infer<typeof resolveSchema>,
  ) {
    return this.cases.resolve(toWorkflowActor(actor), caseId, body);
  }

  @Post(':caseId/close')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_CLOSE.key)
  @Authorize('case.close', 'CaseRecord')
  @ApiOperation({ summary: 'Close a resolved case' })
  @ApiOkResponse({ description: 'Terminal. Reopening means a new case that references this one.' })
  close(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(closeSchema)) body: z.infer<typeof closeSchema>,
  ) {
    return this.cases.close(toWorkflowActor(actor), caseId, body);
  }

  @Post(':caseId/cancel')
  @RequirePermissions(WORKFLOW_PERMISSIONS.CASE_UPDATE.key)
  @Authorize('case.update', 'CaseRecord')
  @ApiOperation({ summary: 'Cancel a case raised in error' })
  @ApiOkResponse({
    description:
      'Distinct from closing. Reporting the two as one number would make a team’s resolution ' +
      'rate depend on how many duplicates they received.',
  })
  cancel(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.cases.cancel(toWorkflowActor(actor), caseId, body.reason);
  }

  // --- collaboration -------------------------------------------------------

  @Get(':caseId/comments')
  @RequirePermissions(WORKFLOW_PERMISSIONS.COMMENT_READ.key)
  @Authorize('workflow.comment.read', 'CaseRecord')
  @ApiOperation({ summary: 'Comments the caller is permitted to see' })
  @ApiOkResponse({
    description:
      'Visibility is computed from the caller’s permissions, server-side. Every comment reports ' +
      'whether it was amended, so a reader knows without asking.',
  })
  async comments_(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Query(new ZodValidationPipe(pageSchema)) query: z.infer<typeof pageSchema>,
  ) {
    const workflowActor = toWorkflowActor(actor);
    await this.cases.find(workflowActor, caseId);

    return this.comments.list(workflowActor, {
      caseId,
      // Never from the request. A client-supplied filter would be a way to ask for
      // `internal` comments and be given them.
      levels: visibleCommentLevels({
        isAdministrator: actorHasPermission(
          workflowActor,
          WORKFLOW_PERMISSIONS.COMMENT_MODERATE.key,
        ),
        isApprover: actorHasPermission(workflowActor, WORKFLOW_PERMISSIONS.APPROVAL_DECIDE.key),
        isParticipant: true,
        isExternalParticipant: false,
      }),
      ...query,
    });
  }

  @Post(':caseId/comments')
  @RequirePermissions(WORKFLOW_PERMISSIONS.COMMENT_WRITE.key)
  @Authorize('workflow.comment.write', 'CaseRecord')
  @ApiOperation({ summary: 'Add a comment' })
  async addComment(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(commentSchema)) body: z.infer<typeof commentSchema>,
  ) {
    const workflowActor = toWorkflowActor(actor);
    await this.cases.find(workflowActor, caseId);

    return this.comments.add(workflowActor, { caseId, ...body });
  }

  @Post('comments/:commentId/amend')
  @RequirePermissions(WORKFLOW_PERMISSIONS.COMMENT_AMEND.key)
  @Authorize('workflow.comment.amend', 'WorkflowComment')
  @ApiOperation({ summary: 'Amend an own comment; the previous text is retained' })
  @ApiOkResponse({
    description:
      'There is no silent edit. The previous text is written to an amendment row and the ' +
      'counter every reader sees is incremented.',
  })
  amendComment(
    @CurrentUser() actor: ActorContext,
    @Param('commentId') commentId: string,
    @Body(new ZodValidationPipe(amendSchema)) body: z.infer<typeof amendSchema>,
  ) {
    return this.comments.amend(toWorkflowActor(actor), commentId, body);
  }

  @Get('comments/:commentId/amendments')
  @RequirePermissions(WORKFLOW_PERMISSIONS.COMMENT_READ.key)
  @ApiOperation({ summary: 'The previous versions of an amended comment' })
  amendments(@CurrentUser() actor: ActorContext, @Param('commentId') commentId: string) {
    return this.comments.amendments(toWorkflowActor(actor), commentId);
  }

  @Post('comments/:commentId/redact')
  @RequirePermissions(WORKFLOW_PERMISSIONS.COMMENT_MODERATE.key)
  @Authorize('workflow.comment.moderate', 'WorkflowComment')
  @ApiOperation({ summary: 'Hide a comment from readers; the original is retained' })
  @ApiOkResponse({
    description:
      'The usual reason to redact is that a comment contains something it should not, which is ' +
      'exactly when the original must remain available to whoever is investigating.',
  })
  redactComment(
    @CurrentUser() actor: ActorContext,
    @Param('commentId') commentId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.comments.redact(toWorkflowActor(actor), commentId, body.reason);
  }

  @Post(':caseId/attachments')
  @RequirePermissions(WORKFLOW_PERMISSIONS.ATTACHMENT_WRITE.key)
  @Authorize('workflow.attachment.write', 'CaseRecord')
  @ApiOperation({ summary: 'Attach an existing document as evidence' })
  @ApiOkResponse({
    description:
      'A reference, not a copy. Refused if the caller cannot read the document — attaching it ' +
      'would make it visible to every participant.',
  })
  async attach(
    @CurrentUser() actor: ActorContext,
    @Param('caseId') caseId: string,
    @Body(new ZodValidationPipe(attachSchema)) body: z.infer<typeof attachSchema>,
  ) {
    const workflowActor = toWorkflowActor(actor);
    await this.cases.find(workflowActor, caseId);

    return this.attachments.attach(workflowActor, { caseId, ...body });
  }

  @Post('attachments/:attachmentId/detach')
  @RequirePermissions(WORKFLOW_PERMISSIONS.ATTACHMENT_REMOVE.key)
  @Authorize('workflow.attachment.remove', 'WorkflowAttachment')
  @ApiOperation({ summary: 'Detach evidence; the document itself is untouched' })
  detach(
    @CurrentUser() actor: ActorContext,
    @Param('attachmentId') attachmentId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
  ) {
    return this.attachments.detach(toWorkflowActor(actor), attachmentId, body.reason);
  }

  @Get('attachments/:attachmentId/verify')
  @RequirePermissions(WORKFLOW_PERMISSIONS.ATTACHMENT_READ.key)
  @ApiOperation({ summary: 'Re-check an attachment’s checksum' })
  @ApiOkResponse({
    description:
      'Answers "is this the file the approver saw?" — a verdict rather than an error, because a ' +
      'mismatch is a finding to investigate.',
  })
  verify(@CurrentUser() actor: ActorContext, @Param('attachmentId') attachmentId: string) {
    return this.attachments.verifyChecksum(toWorkflowActor(actor), attachmentId);
  }
}
