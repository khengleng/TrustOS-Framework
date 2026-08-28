import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';

/**
 * Human review of AI output.
 *
 * The escape hatch that makes the rest of the platform honest. Guardrails reduce the rate of bad
 * output; they do not eliminate it, and no configuration of them ever will. So anything whose
 * cost of being wrong is high goes through a person first, and this is where it waits.
 *
 * Three decisions shape the design:
 *
 *   * **Pending output is not usable.** `result()` throws while an item is pending, rather than
 *     returning the text with a flag beside it. A flag gets ignored; a thrown error does not. This
 *     is the whole point — an item that can be read while pending is an item that reaches a
 *     customer while pending.
 *
 *   * **The reviewer is not the author.** A request created by a person cannot be approved by
 *     that same person. Self-approval turns a control into a formality.
 *
 *   * **A rejection needs a reason and a correction needs the corrected text.** A review that
 *     records "rejected" and nothing else tells the next person nothing, and tells the model
 *     nothing at all — which means the same output comes back tomorrow.
 *
 * **SLA is a report, not a timer.** Nothing here escalates on a schedule; `overdue()` returns what
 * has breached and a job in `@trustos/scheduler` acts on it. A queue that quietly auto-approved on
 * timeout would be a queue that approves precisely the items nobody had time to look at.
 */

export const REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'changes_requested',
  'escalated',
  'cancelled',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_DECISIONS = ['approve', 'reject', 'request_changes', 'escalate'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** Terminal states. A decision on one of these is refused rather than applied. */
const TERMINAL: ReadonlySet<ReviewStatus> = new Set(['approved', 'rejected', 'cancelled']);

export const REVIEW_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type ReviewPriority = (typeof REVIEW_PRIORITIES)[number];

/** How long each priority may wait before it is overdue. */
export const DEFAULT_SLA_MS: Record<ReviewPriority, number> = {
  urgent: 15 * 60 * 1000,
  high: 60 * 60 * 1000,
  normal: 8 * 60 * 60 * 1000,
  low: 3 * 24 * 60 * 60 * 1000,
};

export const reviewEventSchema = z
  .object({
    at: z.coerce.date(),
    actorId: z.string().max(64).nullable(),
    action: z.string().max(60),
    /** What the reviewer said. Required for anything other than an approval. */
    note: z.string().max(5000).nullable().default(null),
    fromStatus: z.enum(REVIEW_STATUSES),
    toStatus: z.enum(REVIEW_STATUSES),
  })
  .strict();

export type ReviewEvent = z.infer<typeof reviewEventSchema>;

export const reviewRequestSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** What produced this. `agent_run`, `completion`, `document`, whatever the application calls it. */
    subjectType: z.string().min(1).max(60),
    subjectId: z.string().min(1).max(120),

    /** The output under review. */
    content: z.string().max(200_000),
    /** What was asked, so a reviewer is not guessing at context. */
    prompt: z.string().max(200_000).nullable().default(null),

    agentId: z.string().max(120).nullable().default(null),
    modelId: z.string().max(120).nullable().default(null),

    /** Why this needs review. Shown to the reviewer, so it is never empty. */
    reason: z.string().min(1).max(1000),

    /**
     * Signals from the automated checks.
     *
     * A guardrail's `needs_review`, an evaluation score, a low groundedness number. The reviewer
     * sees what the machine was unsure about instead of re-deriving it.
     */
    signals: z.array(z.string().max(300)).max(50).default([]),

    priority: z.enum(REVIEW_PRIORITIES).default('normal'),
    status: z.enum(REVIEW_STATUSES).default('pending'),

    /** Who asked. Cannot be the person who approves — see the header. */
    requestedBy: z.string().max(64).nullable().default(null),
    /** Who it is assigned to. Null means the shared queue. */
    assignedTo: z.string().max(64).nullable().default(null),
    /** Permission a reviewer must hold. */
    requiredPermission: z.string().max(120).nullable().default(null),

    decidedBy: z.string().max(64).nullable().default(null),
    decidedAt: z.coerce.date().nullable().default(null),
    /** The reviewer's reasoning. Required for everything except a plain approval. */
    decisionNote: z.string().max(5000).nullable().default(null),
    /**
     * The corrected output.
     *
     * Set when a reviewer fixed the text rather than sending it back. `result()` returns this in
     * place of the original, so a correction is used rather than filed.
     */
    correctedContent: z.string().max(200_000).nullable().default(null),

    dueAt: z.coerce.date(),
    history: z.array(reviewEventSchema).max(200).default([]),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

export interface ReviewStore {
  create(request: ReviewRequest): Promise<ReviewRequest>;
  find(id: string, organizationId: string | null): Promise<ReviewRequest | null>;
  update(id: string, patch: Partial<ReviewRequest>): Promise<ReviewRequest | null>;
  list(input: {
    organizationId: string | null;
    status?: ReviewStatus;
    assignedTo?: string;
    agentId?: string;
    limit?: number;
  }): Promise<ReviewRequest[]>;
  /** Pending items past their due time, oldest first. */
  overdue(organizationId: string | null, now: Date, limit?: number): Promise<ReviewRequest[]>;
}

export interface ReviewServiceOptions {
  store: ReviewStore;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  /** Per-priority deadlines. Defaults to `DEFAULT_SLA_MS`. */
  sla?: Partial<Record<ReviewPriority, number>>;
  /**
   * Whether the author may review their own request.
   *
   * False, and changing it should require a conversation. A single-person team is the usual
   * argument for it, and a single-person team is exactly where the control is doing the most work.
   */
  allowSelfReview?: boolean;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export interface ReviewActor {
  actorId: string | null;
  permissions?: string[];
}

export class ReviewService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly sla: Record<ReviewPriority, number>;

  constructor(private readonly options: ReviewServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.sla = { ...DEFAULT_SLA_MS, ...options.sla };
  }

  /** Queues output for review. */
  async request(input: {
    organizationId: string | null;
    subjectType: string;
    subjectId: string;
    content: string;
    reason: string;
    prompt?: string | null;
    agentId?: string | null;
    modelId?: string | null;
    signals?: string[];
    priority?: ReviewPriority;
    requestedBy?: string | null;
    assignedTo?: string | null;
    requiredPermission?: string | null;
  }): Promise<ReviewRequest> {
    const now = this.now();
    const priority = input.priority ?? 'normal';

    const request = reviewRequestSchema.parse({
      id: this.newId('rev'),
      organizationId: input.organizationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      content: input.content,
      prompt: input.prompt ?? null,
      agentId: input.agentId ?? null,
      modelId: input.modelId ?? null,
      reason: input.reason,
      signals: input.signals ?? [],
      priority,
      status: 'pending',
      requestedBy: input.requestedBy ?? null,
      assignedTo: input.assignedTo ?? null,
      requiredPermission: input.requiredPermission ?? null,
      dueAt: new Date(now.getTime() + this.sla[priority]),
      history: [
        {
          at: now,
          actorId: input.requestedBy ?? null,
          action: 'requested',
          note: input.reason,
          fromStatus: 'pending',
          toStatus: 'pending',
        },
      ],
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.options.store.create(request);

    await this.options.audit?.record({
      action: 'agent.review.requested',
      entityType: 'AiReviewRequest',
      entityId: created.id,
      actorId: input.requestedBy ?? null,
      organizationId: input.organizationId,
      after: {
        subjectType: created.subjectType,
        subjectId: created.subjectId,
        agentId: created.agentId,
        priority: created.priority,
        reason: created.reason,
      },
    });

    return created;
  }

  /**
   * Records a decision.
   *
   * The checks are all about who and why. Everything else is bookkeeping.
   */
  async decide(input: {
    id: string;
    organizationId: string | null;
    actor: ReviewActor;
    decision: ReviewDecision;
    note?: string;
    /** For `request_changes` or a corrected approval. */
    correctedContent?: string;
    /** For `escalate`. */
    escalateTo?: string;
  }): Promise<ReviewRequest> {
    const request = await this.require(input.id, input.organizationId);

    if (TERMINAL.has(request.status)) {
      throw ApiError.conflict(
        `This review was already ${request.status}${request.decidedBy ? ` by ${request.decidedBy}` : ''}. ` +
          'Reopening a decided review would lose the record of the first decision; raise a new ' +
          'request instead.',
        { reason: 'review_already_decided', status: request.status },
      );
    }

    this.assertMayReview(request, input.actor);

    if (input.decision !== 'approve' && !input.note?.trim()) {
      /*
       * A rejection with no reason is not a review.
       *
       * It tells the next person nothing and the model nothing, so the same output comes back
       * tomorrow. Approvals are exempt: "this is fine" is a complete thought.
       */
      throw ApiError.validation(
        [
          {
            path: 'note',
            message:
              `A ${input.decision.replace('_', ' ')} decision needs a reason. Without one the next ` +
              'person cannot act on it and the same output comes back tomorrow.',
          },
        ],
        'This decision needs a reason.',
      );
    }

    const now = this.now();

    const toStatus: ReviewStatus =
      input.decision === 'approve'
        ? 'approved'
        : input.decision === 'reject'
          ? 'rejected'
          : input.decision === 'request_changes'
            ? 'changes_requested'
            : 'escalated';

    const event: ReviewEvent = reviewEventSchema.parse({
      at: now,
      actorId: input.actor.actorId,
      action: input.decision,
      note: input.note ?? null,
      fromStatus: request.status,
      toStatus,
    });

    const patch: Partial<ReviewRequest> = {
      status: toStatus,
      decisionNote: input.note ?? null,
      updatedAt: now,
      history: [...request.history, event],
      ...(input.correctedContent !== undefined ? { correctedContent: input.correctedContent } : {}),
      // Escalation reassigns and stays open; it is not a decision about the content.
      ...(input.decision === 'escalate'
        ? { assignedTo: input.escalateTo ?? null }
        : { decidedBy: input.actor.actorId, decidedAt: now }),
    };

    const updated = await this.options.store.update(input.id, patch);
    if (!updated) throw ApiError.notFound(`No review request with id "${input.id}".`);

    await this.options.audit?.record({
      action: `agent.review.${input.decision}`,
      entityType: 'AiReviewRequest',
      entityId: updated.id,
      actorId: input.actor.actorId,
      organizationId: input.organizationId,
      before: { status: request.status },
      after: {
        status: updated.status,
        note: input.note ?? null,
        corrected: input.correctedContent !== undefined,
        subjectType: updated.subjectType,
        subjectId: updated.subjectId,
      },
    });

    return updated;
  }

  /** Assigns a review, or moves it back to the shared queue with null. */
  async assign(input: {
    id: string;
    organizationId: string | null;
    actor: ReviewActor;
    assignTo: string | null;
  }): Promise<ReviewRequest> {
    const request = await this.require(input.id, input.organizationId);

    if (TERMINAL.has(request.status)) {
      throw ApiError.conflict(`This review was already ${request.status}.`, {
        reason: 'review_already_decided',
      });
    }

    const now = this.now();

    const updated = await this.options.store.update(input.id, {
      assignedTo: input.assignTo,
      updatedAt: now,
      history: [
        ...request.history,
        reviewEventSchema.parse({
          at: now,
          actorId: input.actor.actorId,
          action: input.assignTo ? `assigned to ${input.assignTo}` : 'returned to the queue',
          note: null,
          fromStatus: request.status,
          toStatus: request.status,
        }),
      ],
    });

    if (!updated) throw ApiError.notFound(`No review request with id "${input.id}".`);
    return updated;
  }

  /**
   * The reviewed output.
   *
   * Throws while pending, and that is the point. A method returning the text with a
   * `pending: true` beside it is a method whose flag gets ignored on a Friday afternoon.
   */
  async result(
    id: string,
    organizationId: string | null,
  ): Promise<{
    content: string;
    corrected: boolean;
    approvedBy: string | null;
    approvedAt: Date | null;
  }> {
    const request = await this.require(id, organizationId);

    if (request.status !== 'approved') {
      throw ApiError.conflict(
        request.status === 'pending'
          ? 'This output is still awaiting review and must not be used yet.'
          : `This output was ${request.status.replace('_', ' ')} and must not be used.`,
        { reason: 'review_required', status: request.status },
      );
    }

    return {
      // The correction, when there is one. A corrected approval whose correction is filed and
      // unused is the reviewer's time wasted and the original text still shipping.
      content: request.correctedContent ?? request.content,
      corrected: request.correctedContent !== null,
      approvedBy: request.decidedBy,
      approvedAt: request.decidedAt,
    };
  }

  /** Whether this output may be used, without throwing. For a caller deciding what to render. */
  async isUsable(id: string, organizationId: string | null): Promise<boolean> {
    const request = await this.options.store.find(id, organizationId);
    return request?.status === 'approved';
  }

  async pending(input: {
    organizationId: string | null;
    assignedTo?: string;
    limit?: number;
  }): Promise<ReviewRequest[]> {
    return this.options.store.list({ ...input, status: 'pending' });
  }

  /**
   * What has breached its SLA.
   *
   * A report rather than an action. Nothing here escalates on a timer, because the only automatic
   * action a review queue could take on timeout is approving things nobody had time to look at.
   */
  async overdue(organizationId: string | null, limit = 50): Promise<ReviewRequest[]> {
    return this.options.store.overdue(organizationId, this.now(), limit);
  }

  /** Queue health, for a dashboard. */
  async stats(organizationId: string | null): Promise<{
    pending: number;
    overdue: number;
    oldestPendingAgeMs: number | null;
    byPriority: Record<ReviewPriority, number>;
  }> {
    const pending = await this.options.store.list({
      organizationId,
      status: 'pending',
      limit: 1000,
    });
    const now = this.now();

    const byPriority = { low: 0, normal: 0, high: 0, urgent: 0 } as Record<ReviewPriority, number>;
    for (const request of pending) byPriority[request.priority] += 1;

    const oldest = pending.reduce<Date | null>(
      (found, request) => (!found || request.createdAt < found ? request.createdAt : found),
      null,
    );

    return {
      pending: pending.length,
      overdue: pending.filter((request) => request.dueAt < now).length,
      oldestPendingAgeMs: oldest ? now.getTime() - oldest.getTime() : null,
      byPriority,
    };
  }

  private assertMayReview(request: ReviewRequest, actor: ReviewActor): void {
    if (
      request.requiredPermission &&
      !(actor.permissions ?? []).includes(request.requiredPermission)
    ) {
      throw ApiError.forbidden(
        `Reviewing this needs the "${request.requiredPermission}" permission.`,
        { reason: 'review_permission_denied', required: request.requiredPermission },
      );
    }

    if (
      !this.options.allowSelfReview &&
      request.requestedBy !== null &&
      request.requestedBy === actor.actorId
    ) {
      /*
       * Self-approval turns a control into a formality.
       *
       * The point of review is a second judgement. One person producing the output and approving
       * it is one judgement with extra steps, and the record afterwards says it was reviewed.
       */
      throw ApiError.forbidden(
        'You raised this review, so you cannot decide it. Review exists to add a second ' +
          'judgement, and approving your own output is the first judgement with extra steps.',
        { reason: 'self_review_denied' },
      );
    }
  }

  private async require(id: string, organizationId: string | null): Promise<ReviewRequest> {
    const request = await this.options.store.find(id, organizationId);
    if (!request) throw ApiError.notFound(`No review request with id "${id}".`);
    return request;
  }
}
