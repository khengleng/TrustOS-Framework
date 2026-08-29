import { z } from 'zod';

/**
 * The Approval Workbench read models.
 *
 * A queue row is the one thing the framework genuinely does not already have. A task
 * knows it is due on Tuesday and a workflow instance knows it is a User Access Change
 * Request raised by Ada; neither knows both, and a reviewer deciding what to open next
 * needs both on one line. That join is an application concern, so it lives here rather
 * than being pushed into the workflow packages, where it would serve one caller.
 *
 * Nothing here is authoritative. Every field is projected from a record the workflow
 * engine owns, and the projection is one-way: there is no path from a row back to a
 * write.
 */

export const QUEUE_SORT_FIELDS = ['dueAt', 'submittedAt', 'priority', 'title'] as const;
export type QueueSortField = (typeof QUEUE_SORT_FIELDS)[number];

export const QUEUE_SCOPES = ['available', 'mine', 'completed', 'rejected', 'returned'] as const;
export type QueueScope = (typeof QUEUE_SCOPES)[number];

/**
 * A queue query.
 *
 * Parsed rather than trusted. Note there is no `organizationId` and no `actorId`: both
 * are taken from the verified actor at the call site. A queue filter that accepted a
 * tenant would be a cross-tenant read with extra steps.
 */
export const approvalQueueQuerySchema = z
  .object({
    scope: z.enum(QUEUE_SCOPES).default('available'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    /** Free-text over title, request type and requester. Matched case-insensitively. */
    search: z.string().trim().max(200).optional(),
    requestType: z.string().trim().max(120).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    state: z.string().trim().max(120).optional(),
    /** Only rows whose SLA has been breached. */
    breachedOnly: z.coerce.boolean().optional(),
    sortBy: z.enum(QUEUE_SORT_FIELDS).default('dueAt'),
    sortDirection: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();

export type ApprovalQueueQuery = z.infer<typeof approvalQueueQuerySchema>;

/** One line in the queue. Every field is projected; none is authoritative. */
export interface ApprovalQueueRow {
  taskId: string;
  workflowInstanceId: string;
  /** The business object under review — what the request is *about*. */
  requestId: string;
  requestType: string;
  title: string;
  requestedBy: string;
  organizationId: string;
  submittedAt: Date;
  currentState: string;
  priority: string;
  dueAt: Date | null;
  slaStatus: string | null;
  slaBreached: boolean;
  /** Exactly one of these is the authority for who may act. */
  assignedToUserId: string | null;
  assignedToRole: string | null;
  assignedToGroupId: string | null;
  /** The instance version this row was read at. Carried so a decision can prove freshness. */
  version: number;
}

export interface ApprovalQueuePage {
  rows: ApprovalQueueRow[];
  total: number;
  page: number;
  pageSize: number;
  scope: QueueScope;
}

/**
 * A decision submission.
 *
 * `expectedVersion` is required, not optional. The engine will accept a transition
 * without one, and for a background job that is right; for a person acting on a screen
 * it is not. If the reviewer's screen was built before somebody else decided, the
 * correct outcome is a conflict they can see, not a second decision recorded against a
 * step that has already settled.
 */
export const decisionRequestSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'return_for_rework']),
    expectedVersion: z.coerce.number().int().min(0),
    reasonCode: z.string().trim().min(1).max(120).nullish(),
    explanation: z.string().trim().max(4000).nullish(),
    /** Reused across retries of the same click. */
    idempotencyKey: z.string().trim().min(8).max(200).nullish(),
  })
  .strict();

export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

/** Reason is required for anything that is not an approval. */
export function decisionNeedsReason(action: DecisionRequest['action']): boolean {
  return action !== 'approve';
}

/** What a reviewer sees on one request. */
export interface ApprovalDetail {
  requestId: string;
  workflowInstanceId: string;
  requestType: string;
  title: string;
  requestedBy: string;
  organizationId: string;
  currentState: string;
  previousState: string | null;
  status: string;
  priority: string;
  submittedAt: Date;
  dueAt: Date | null;
  version: number;
  reworkCount: number;
  /** The definition version this instance is pinned to, for the life of the request. */
  workflowVersion: string;
  /** The change being requested. Filtered to what the step declares readable. */
  requestedChange: Record<string, unknown>;
  /** The actions the engine says this actor may take, right now. */
  eligibleActions: string[];
  decisions: ApprovalDecisionView[];
  auditTimeline: ApprovalAuditEntry[];
  comments: FeatureView<Array<Record<string, unknown>>>;
  attachments: FeatureView<Array<Record<string, unknown>>>;
  /** The task this reviewer would act through, when one is theirs to act on. */
  taskId: string | null;
  correlation: { workflowInstanceId: string; businessObjectId: string; requestId: string | null };
}

/**
 * A feature that a deployment may not have wired.
 *
 * `unavailable` is deliberately distinct from an empty list. A screen that renders
 * nothing for both says "nobody commented" when the truth is "comments are not
 * configured", and the reviewer draws a conclusion from an absence that was never
 * evidence.
 */
export type FeatureView<T> = { available: true; items: T } | { available: false; reason: string };

export interface ApprovalDecisionView {
  decisionId: string;
  stepKey: string;
  actorId: string;
  actorRole: string | null;
  decision: string;
  reasonCode: string | null;
  explanation: string | null;
  reworkCycle: number;
  decidedAt: Date;
  /** Connects the decision to the authorization decision that permitted it. */
  policyDecisionId: string | null;
}

export interface ApprovalAuditEntry {
  id: string;
  action: string;
  actorId: string | null;
  occurredAt: Date;
}
