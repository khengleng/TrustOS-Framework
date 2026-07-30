import { ApiError } from '@trustos/errors';
import {
  crossTenant,
  type AttachmentClassification,
  type CommentVisibility,
  type WorkflowActor,
  type WorkflowAttachmentRecord,
  type WorkflowCommentAmendmentRecord,
  type WorkflowCommentRecord,
} from '@trustos/workflow-core';

/**
 * Comments and attachments.
 *
 * Two rules shape this file, and both are about evidence rather than convenience.
 *
 * **A comment cannot be silently edited.** Editing writes the previous text to an
 * amendment row and increments a counter that is visible to every reader. A reviewer's
 * comment is often the only record of *why* something was returned, and a comment that
 * can change without trace is not a record — it is a claim about what somebody said.
 *
 * **An attachment is a reference, not a copy.** The bytes live in the document module.
 * This records that a document is evidence for a workflow, who attached it and what it
 * is — so detaching does not delete a document another workflow also cites, and the
 * same document can be evidence in two places without being stored twice.
 */

// --- comments --------------------------------------------------------------

export interface CommentStore {
  findById(id: string, organizationId: string): Promise<WorkflowCommentRecord | null>;
  create(
    input: Omit<WorkflowCommentRecord, 'id' | 'createdAt' | 'updatedAt' | 'amendmentCount'>,
  ): Promise<WorkflowCommentRecord>;

  /**
   * Amends a comment, writing the previous text.
   *
   * One method rather than an update plus an insert, because the two must be atomic:
   * an amendment row without the corresponding update leaves history claiming an edit
   * that did not happen, and an update without the amendment row is precisely the
   * silent edit this file exists to prevent.
   */
  amend(input: {
    id: string;
    organizationId: string;
    newMessage: string;
    amendedById: string;
    reason: string | null;
    at: Date;
  }): Promise<{ comment: WorkflowCommentRecord; amendment: WorkflowCommentAmendmentRecord }>;

  /** Records a redaction. The original text is retained. */
  redact(input: {
    id: string;
    organizationId: string;
    redactedById: string;
    at: Date;
  }): Promise<WorkflowCommentRecord>;

  list(input: {
    organizationId: string;
    workflowInstanceId?: string;
    caseId?: string;
    /** Visibilities the reader may see. Computed server-side, never passed by a client. */
    visibilities: CommentVisibility[];
    page: number;
    pageSize: number;
  }): Promise<{ items: WorkflowCommentRecord[]; total: number }>;

  listAmendments(
    commentId: string,
    organizationId: string,
  ): Promise<WorkflowCommentAmendmentRecord[]>;
}

/**
 * Which comment visibilities an actor may read.
 *
 * Computed from the actor's permissions and role, **never** taken from a request. A
 * client-supplied visibility filter would be a way to ask for `internal` comments and
 * be given them.
 *
 * The ordering is a hierarchy: an administrator sees everything, an approver sees
 * everything a participant sees plus approver-only notes, a participant sees the
 * participant and external levels. `internal` is the narrowest and is for notes that
 * must never reach an external participant even by accident.
 */
export function visibleCommentLevels(input: {
  isAdministrator: boolean;
  isApprover: boolean;
  isParticipant: boolean;
  isExternalParticipant: boolean;
}): CommentVisibility[] {
  if (input.isAdministrator) {
    return ['participants', 'approvers', 'administrators', 'internal', 'external'];
  }
  if (input.isApprover) {
    // Not `administrators`: an approver is a participant with judgement, not an
    // operator, and administrator notes are often about the approver.
    return ['participants', 'approvers', 'internal', 'external'];
  }
  if (input.isParticipant) {
    return ['participants', 'external'];
  }
  if (input.isExternalParticipant) {
    // The narrowest set, and the only one that excludes `participants`. An external
    // party — the merchant under review — sees what was addressed to them and nothing
    // said about them.
    return ['external'];
  }
  return [];
}

/**
 * What a history recorder is told about a comment.
 *
 * Deliberately **not** the comment record. Handing over the whole thing would put the
 * message text one careless `metadata: comment` away from being copied into history —
 * which a test caught by asserting the text did not appear in the callback payload, and
 * finding that it did.
 *
 * The text belongs in exactly one place, the comment row, because that is the row an
 * amendment updates. A copy in history is a second version that a later correction does
 * not reach.
 */
export interface CommentRecordedNotice {
  type: 'comment.added' | 'comment.amended';
  commentId: string;
  /**
   * The owning organization.
   *
   * Carried explicitly, because history is tenant-scoped and a recorder that had to derive
   * the organization from somewhere else would derive it wrongly. A first version of the
   * composition root wrote `organizationId: ''` here for exactly that reason.
   */
  organizationId: string;
  workflowInstanceId: string | null;
  caseId: string | null;
  workflowTaskId: string | null;
  actorId: string;
  metadata: Record<string, unknown>;
}

export interface CommentServiceOptions {
  store: CommentStore;
  /** Records `comment.added` / `comment.amended` in history. */
  onRecorded?: (input: CommentRecordedNotice) => Promise<void>;
  now?: () => Date;
}

export const MAX_COMMENT_LENGTH = 8000;

export class CommentService {
  private readonly now: () => Date;

  constructor(private readonly options: CommentServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async add(
    actor: WorkflowActor,
    input: {
      workflowInstanceId?: string | null;
      caseId?: string | null;
      workflowTaskId?: string | null;
      stepKey?: string | null;
      message: string;
      visibility: CommentVisibility;
    },
  ): Promise<WorkflowCommentRecord> {
    const message = input.message.trim();

    if (!message) {
      throw ApiError.validation(
        [{ path: 'message', message: 'A comment cannot be empty.' }],
        'A comment needs a message.',
      );
    }
    if (message.length > MAX_COMMENT_LENGTH) {
      throw ApiError.validation(
        [
          {
            path: 'message',
            message: `A comment is limited to ${MAX_COMMENT_LENGTH} characters.`,
          },
        ],
        'This comment is too long.',
      );
    }
    if (!input.workflowInstanceId && !input.caseId) {
      throw ApiError.validation(
        [{ path: 'workflowInstanceId', message: 'A comment needs a workflow instance or a case.' }],
        'A comment must be attached to something.',
      );
    }

    const comment = await this.options.store.create({
      organizationId: actor.organizationId,
      workflowInstanceId: input.workflowInstanceId ?? null,
      caseId: input.caseId ?? null,
      workflowTaskId: input.workflowTaskId ?? null,
      stepKey: input.stepKey ?? null,
      authorId: actor.userId,
      authorActorType: actor.actorType,
      message,
      visibility: input.visibility,
      redactedAt: null,
      redactedById: null,
    });

    await this.options.onRecorded?.({
      type: 'comment.added',
      commentId: comment.id,
      organizationId: comment.organizationId,
      workflowInstanceId: comment.workflowInstanceId,
      caseId: comment.caseId,
      workflowTaskId: comment.workflowTaskId,
      actorId: actor.userId,
      // The visibility and the length, not the text.
      metadata: { visibility: input.visibility, length: message.length, stepKey: input.stepKey },
    });

    return comment;
  }

  /**
   * Amends a comment, retaining the previous text.
   *
   * Only the author, and only their own comment. An administrator who disagrees with a
   * comment redacts it — which is also recorded — rather than editing it: an
   * administrator who could rewrite somebody else's words could rewrite the reason a
   * request was rejected.
   *
   * A reason is required. An amendment with no explanation raises the question it was
   * meant to answer.
   */
  async amend(
    actor: WorkflowActor,
    commentId: string,
    input: { message: string; reason: string },
  ): Promise<{ comment: WorkflowCommentRecord; amendment: WorkflowCommentAmendmentRecord }> {
    const existing = await this.require(actor, commentId);

    if (existing.authorId !== actor.userId) {
      throw ApiError.forbidden(
        'Only the author can amend a comment. An administrator may redact it instead, which is ' +
          'also recorded.',
        { reason: 'not_comment_author' },
      );
    }
    if (existing.redactedAt) {
      throw ApiError.conflict('A redacted comment cannot be amended.', {
        reason: 'comment_redacted',
      });
    }

    const message = input.message.trim();
    if (!message) {
      throw ApiError.validation(
        [{ path: 'message', message: 'An amended comment cannot be empty.' }],
        'An amendment needs a message.',
      );
    }
    if (message === existing.message) {
      // Refused rather than accepted as a no-op: writing an amendment row for an
      // identical message would put "amended" on a comment nobody changed, which
      // misleads the next reader.
      throw ApiError.validation(
        [{ path: 'message', message: 'The message is unchanged.' }],
        'Nothing to amend.',
      );
    }
    if (!input.reason.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'An amendment needs a reason.' }],
        'Say why the comment is being amended.',
      );
    }

    const result = await this.options.store.amend({
      id: commentId,
      organizationId: actor.organizationId,
      newMessage: message,
      amendedById: actor.userId,
      reason: input.reason.trim(),
      at: this.now(),
    });

    await this.options.onRecorded?.({
      type: 'comment.amended',
      commentId: result.comment.id,
      organizationId: result.comment.organizationId,
      workflowInstanceId: result.comment.workflowInstanceId,
      caseId: result.comment.caseId,
      workflowTaskId: result.comment.workflowTaskId,
      actorId: actor.userId,
      metadata: {
        amendmentCount: result.comment.amendmentCount,
        reason: input.reason.trim(),
        // Lengths, not texts. A reader who needs the previous wording reads the
        // amendment row, which is the authoritative copy.
        previousLength: existing.message.length,
        newLength: message.length,
      },
    });

    return result;
  }

  /**
   * Redacts a comment.
   *
   * The text is retained in the row and hidden from readers. Deleting it would remove
   * evidence, and the usual reason to redact is that a comment contains something it
   * should not — a customer's identity number pasted into a note — which is exactly the
   * case where the original must remain available to whoever is investigating.
   */
  async redact(
    actor: WorkflowActor,
    commentId: string,
    reason: string,
  ): Promise<WorkflowCommentRecord> {
    const existing = await this.require(actor, commentId);
    if (existing.redactedAt) return existing;

    if (!reason.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'A redaction needs a reason.' }],
        'Say why the comment is being redacted.',
      );
    }

    return this.options.store.redact({
      id: commentId,
      organizationId: actor.organizationId,
      redactedById: actor.userId,
      at: this.now(),
    });
  }

  /**
   * Comments the actor may see.
   *
   * The visibility set is computed from the actor and passed to the store as a filter,
   * so the database returns only what the reader may see. Filtering after the fact
   * would mean the narrower levels were read out of the database and then discarded,
   * which is one refactor away from being returned.
   */
  async list(
    actor: WorkflowActor,
    input: {
      workflowInstanceId?: string;
      caseId?: string;
      levels: CommentVisibility[];
      page?: number;
      pageSize?: number;
    },
  ): Promise<{ items: Array<WorkflowCommentRecord & { amended: boolean }>; total: number }> {
    const result = await this.options.store.list({
      organizationId: actor.organizationId,
      ...(input.workflowInstanceId ? { workflowInstanceId: input.workflowInstanceId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      visibilities: input.levels,
      page: input.page ?? 1,
      pageSize: Math.min(Math.max(input.pageSize ?? 25, 1), 100),
    });

    return {
      items: result.items.map((comment) => ({
        ...comment,
        // Surfaced on every comment, not only on request. A reader deciding whether to
        // trust a comment needs to know it was edited without having to ask.
        amended: comment.amendmentCount > 0,
        ...(comment.redactedAt ? { message: '[REDACTED]' } : {}),
      })),
      total: result.total,
    };
  }

  amendments(actor: WorkflowActor, commentId: string): Promise<WorkflowCommentAmendmentRecord[]> {
    return this.options.store.listAmendments(commentId, actor.organizationId);
  }

  private async require(actor: WorkflowActor, id: string): Promise<WorkflowCommentRecord> {
    const comment = await this.options.store.findById(id, actor.organizationId);
    if (!comment) throw crossTenant();
    return comment;
  }
}

// --- attachments -----------------------------------------------------------

/**
 * The document module, as this package needs it.
 *
 * Four methods. Deliberately not a dependency on `@trustos/module-document`: that
 * module is an optional install, and a workflow engine that could not accept evidence
 * without it would be unusable in most deployments. The module satisfies this
 * interface.
 */
export interface DocumentPort {
  /** Confirms the document exists and belongs to the organization. */
  find(input: { documentId: string; organizationId: string }): Promise<{
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    checksum: string;
  } | null>;

  /** Whether the actor may read the document. Enforced by the document module's own RBAC. */
  canRead(input: { documentId: string; organizationId: string; userId: string }): Promise<boolean>;
}

export interface AttachmentStore {
  findById(id: string, organizationId: string): Promise<WorkflowAttachmentRecord | null>;
  create(input: Omit<WorkflowAttachmentRecord, 'id'>): Promise<WorkflowAttachmentRecord>;
  markRemoved(input: {
    id: string;
    organizationId: string;
    removedById: string;
    at: Date;
  }): Promise<WorkflowAttachmentRecord>;
  list(input: {
    organizationId: string;
    workflowInstanceId?: string;
    caseId?: string;
    stepKey?: string;
    includeRemoved?: boolean;
  }): Promise<WorkflowAttachmentRecord[]>;
  countForStep(input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
  }): Promise<number>;
}

export interface AttachmentServiceOptions {
  store: AttachmentStore;
  documents: DocumentPort;
  /**
   * Records `attachment.added` / `attachment.removed`.
   *
   * Narrow, for the same reason as `CommentRecordedNotice`: the recorder gets ids and the
   * anchor, and the metadata it should write. An attachment record holds no free text, so
   * the risk is lower — but two shapes for one purpose is one shape somebody uses wrongly.
   */
  onRecorded?: (input: {
    type: 'attachment.added' | 'attachment.removed';
    attachmentId: string;
    /** The owning organization. See the note on `CommentRecordedNotice`. */
    organizationId: string;
    workflowInstanceId: string | null;
    caseId: string | null;
    workflowTaskId: string | null;
    actorId: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  now?: () => Date;
}

export class AttachmentService {
  private readonly now: () => Date;

  constructor(private readonly options: AttachmentServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Attaches an existing document as evidence.
   *
   * Three checks before the reference is written, and each closes a different hole:
   *
   *   1. The document exists **in this organization**. Without it, an attachment is a
   *      way to test whether a document id exists elsewhere.
   *   2. The actor may read it. Attaching a document to a workflow makes it visible to
   *      every participant, so somebody who cannot read a document must not be able to
   *      publish it to a review board.
   *   3. The checksum is recorded now, from the document module's own value. That is
   *      what makes "is this still the file the approver saw?" answerable later.
   */
  async attach(
    actor: WorkflowActor,
    input: {
      documentId: string;
      workflowInstanceId?: string | null;
      caseId?: string | null;
      workflowTaskId?: string | null;
      stepKey?: string | null;
      classification: AttachmentClassification;
    },
  ): Promise<WorkflowAttachmentRecord> {
    if (!input.workflowInstanceId && !input.caseId) {
      throw ApiError.validation(
        [
          {
            path: 'workflowInstanceId',
            message: 'An attachment needs a workflow instance or a case.',
          },
        ],
        'An attachment must be attached to something.',
      );
    }

    const document = await this.options.documents.find({
      documentId: input.documentId,
      organizationId: actor.organizationId,
    });

    // Not found rather than forbidden: a 403 would confirm the document exists in
    // another organization.
    if (!document) throw crossTenant();

    const readable = await this.options.documents.canRead({
      documentId: input.documentId,
      organizationId: actor.organizationId,
      userId: actor.userId,
    });

    if (!readable) {
      throw ApiError.forbidden(
        'You cannot attach a document you are not permitted to read. Attaching it would make it ' +
          'visible to every participant in this workflow.',
        { reason: 'attachment_not_readable' },
      );
    }

    const attachment = await this.options.store.create({
      organizationId: actor.organizationId,
      workflowInstanceId: input.workflowInstanceId ?? null,
      caseId: input.caseId ?? null,
      workflowTaskId: input.workflowTaskId ?? null,
      stepKey: input.stepKey ?? null,
      documentId: document.id,
      filename: document.filename,
      contentType: document.contentType,
      sizeBytes: document.sizeBytes,
      checksum: document.checksum,
      classification: input.classification,
      /*
       * Always `not_scanned` in this phase.
       *
       * The field exists so that adding a scanner later does not need a migration, and
       * so a deployment can see at a glance that nothing has been scanned. Defaulting
       * it to `clean` would be a lie that a compliance review would eventually find.
       */
      scanStatus: 'not_scanned',
      attachedById: actor.userId,
      attachedAt: this.now(),
      removedAt: null,
      removedById: null,
    });

    await this.options.onRecorded?.({
      type: 'attachment.added',
      attachmentId: attachment.id,
      organizationId: attachment.organizationId,
      workflowInstanceId: attachment.workflowInstanceId,
      caseId: attachment.caseId,
      workflowTaskId: attachment.workflowTaskId,
      actorId: actor.userId,
      metadata: {
        documentId: document.id,
        filename: document.filename,
        classification: input.classification,
        sizeBytes: document.sizeBytes,
        checksum: document.checksum,
        stepKey: input.stepKey,
      },
    });

    return attachment;
  }

  /**
   * Detaches evidence.
   *
   * Marks the reference removed; the document is untouched. Two reasons: another
   * workflow may cite the same document, and an approver's decision was made with this
   * evidence in front of them — so the fact that it *was* attached has to survive its
   * removal.
   */
  async detach(
    actor: WorkflowActor,
    attachmentId: string,
    reason: string,
  ): Promise<WorkflowAttachmentRecord> {
    const existing = await this.options.store.findById(attachmentId, actor.organizationId);
    if (!existing) throw crossTenant();
    if (existing.removedAt) return existing;

    const removed = await this.options.store.markRemoved({
      id: attachmentId,
      organizationId: actor.organizationId,
      removedById: actor.userId,
      at: this.now(),
    });

    await this.options.onRecorded?.({
      type: 'attachment.removed',
      attachmentId: removed.id,
      organizationId: removed.organizationId,
      workflowInstanceId: removed.workflowInstanceId,
      caseId: removed.caseId,
      workflowTaskId: removed.workflowTaskId,
      actorId: actor.userId,
      metadata: { documentId: existing.documentId, reason },
    });

    return removed;
  }

  list(
    actor: WorkflowActor,
    input: { workflowInstanceId?: string; caseId?: string; includeRemoved?: boolean },
  ): Promise<WorkflowAttachmentRecord[]> {
    return this.options.store.list({
      organizationId: actor.organizationId,
      ...(input.workflowInstanceId ? { workflowInstanceId: input.workflowInstanceId } : {}),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(input.includeRemoved ? { includeRemoved: true } : {}),
    });
  }

  /**
   * Whether a step's evidence requirement is met.
   *
   * Counts only attachments that are still attached — a step whose evidence was
   * detached no longer satisfies the requirement, which is the behaviour that stops
   * "attach, get approved, detach" being a way around it.
   */
  async hasRequiredAttachment(input: {
    organizationId: string;
    workflowInstanceId: string;
    stepKey: string;
  }): Promise<boolean> {
    const count = await this.options.store.countForStep(input);
    return count > 0;
  }

  /**
   * Re-verifies a checksum.
   *
   * Answers "is this the file the approver saw?" — which matters when a decision is
   * questioned months later. Returns a verdict rather than throwing, because a mismatch
   * is a finding to investigate rather than a request to fail.
   */
  async verifyChecksum(
    actor: WorkflowActor,
    attachmentId: string,
  ): Promise<{ matches: boolean; recorded: string; current: string | null }> {
    const attachment = await this.options.store.findById(attachmentId, actor.organizationId);
    if (!attachment) throw crossTenant();

    const document = await this.options.documents.find({
      documentId: attachment.documentId,
      organizationId: actor.organizationId,
    });

    return {
      matches: document?.checksum === attachment.checksum,
      recorded: attachment.checksum,
      current: document?.checksum ?? null,
    };
  }
}
