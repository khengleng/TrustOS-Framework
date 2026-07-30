import type { ActorType } from '@trustos/shared-types';

/**
 * The workflow domain, as types.
 *
 * This package holds no logic on purpose. Nine other packages depend on these
 * shapes, and a runtime dependency here would make every one of them depend on the
 * runtime — so the state machine, the approval models and the SLA evaluator all
 * import from here and none of them import each other's implementations.
 *
 * Two conventions run through the whole file:
 *
 *   * `organizationId` is on every tenant-owned record, and it is never optional
 *     where a record belongs to a tenant. A nullable tenant column is a query
 *     somebody will forget to filter.
 *   * States and actions are `string`, not unions. The framework ships example
 *     states because a framework has to show one, but a definition declares its
 *     own — and a union here would mean a product could not name a state the
 *     framework had not thought of.
 */

// --- identifiers -----------------------------------------------------------

export type WorkflowDefinitionId = string;
export type WorkflowVersionId = string;
export type WorkflowInstanceId = string;
export type WorkflowTaskId = string;
export type CaseId = string;

/**
 * A workflow state.
 *
 * Deliberately `string`. See the note at the top of the file.
 */
export type WorkflowState = string;

/** A transition's name — the verb an actor asks for. */
export type WorkflowAction = string;

// --- example states and actions --------------------------------------------

/**
 * States the framework's own example workflow uses.
 *
 * Exported for convenience and for the tests, **not** as the allowed set. A
 * definition that uses none of these is a valid definition.
 */
export const EXAMPLE_STATES = [
  'draft',
  'submitted',
  'under_review',
  'pending_approval',
  'approved',
  'rejected',
  'returned_for_rework',
  'cancelled',
  'completed',
] as const;

/** Actions the example workflow uses. Same caveat as `EXAMPLE_STATES`. */
export const EXAMPLE_ACTIONS = [
  'submit',
  'request_approval',
  'approve',
  'reject',
  'return_for_rework',
  'resubmit',
  'cancel',
  'complete',
] as const;

// --- definition lifecycle --------------------------------------------------

export const WORKFLOW_DEFINITION_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'published',
  'retired',
] as const;

export type WorkflowDefinitionStatus = (typeof WORKFLOW_DEFINITION_STATUSES)[number];

/**
 * A definition's identity across versions.
 *
 * The row that says "there is a workflow called change-request-approval". Its
 * versions hold the actual states and transitions; this holds only what does not
 * change between them.
 */
export interface WorkflowDefinitionRecord {
  id: WorkflowDefinitionId;
  /**
   * Null means a framework-level definition available to every tenant.
   *
   * The one place a null organization is correct: a definition shipped by the
   * platform is not owned by a customer. Every *instance* of it has a real
   * organization, and that is where isolation is enforced.
   */
  organizationId: string | null;
  key: string;
  name: string;
  description: string;
  /** What this workflow governs: `Merchant`, `Payment`, `AccessRequest`. */
  businessObjectType: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Soft-deleted definitions keep their instances resolvable. */
  deletedAt: Date | null;
}

/**
 * One immutable version.
 *
 * `definition` holds the validated document. After `publishedAt` is set, nothing
 * in this row may change — see `docs/workflow-versioning.md`. A change is a new
 * row, which is what lets a running instance keep the rules it started under.
 */
export interface WorkflowVersionRecord {
  id: WorkflowVersionId;
  workflowDefinitionId: WorkflowDefinitionId;
  organizationId: string | null;
  /** Semantic version, unique per definition. */
  version: string;
  status: WorkflowDefinitionStatus;
  /** The validated definition document. */
  definition: unknown;
  /** Detects tampering with a published version. */
  definitionHash: string;
  initialState: WorkflowState;
  finalStates: WorkflowState[];
  effectiveFrom: Date | null;
  createdById: string | null;
  /** Set when an independent actor approves. Never the creator. */
  approvedById: string | null;
  approvedAt: Date | null;
  publishedById: string | null;
  publishedAt: Date | null;
  retiredAt: Date | null;
  retiredReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- instances -------------------------------------------------------------

export const WORKFLOW_INSTANCE_STATUSES = [
  'active',
  'completed',
  'cancelled',
  /** Terminal by rejection, distinct from cancelled: a decision, not an abandonment. */
  'rejected',
] as const;

export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];

export interface WorkflowInstanceRecord {
  id: WorkflowInstanceId;
  organizationId: string;
  workflowDefinitionId: WorkflowDefinitionId;
  /** The version this instance runs under, for its whole life. */
  workflowVersionId: WorkflowVersionId;
  /** Denormalised so history reads do not need a join to say which rules applied. */
  workflowVersion: string;
  status: WorkflowInstanceStatus;
  currentState: WorkflowState;
  /** Generic business-object reference. See `docs/workflow-architecture.md`. */
  businessObjectType: string;
  businessObjectId: string;
  /** Caller-supplied context the definition's conditions read. Never trusted for identity. */
  data: Record<string, unknown>;
  priority: WorkflowPriority;
  /** Who started it. The maker, for separation-of-duty checks. */
  initiatedById: string;
  initiatedByActorType: ActorType;
  /**
   * Optimistic lock. Every transition increments it, and a transition that
   * presents a stale version is refused rather than applied to a changed record.
   */
  version: number;
  reworkCount: number;
  startedAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledById: string | null;
  cancellationReason: string | null;
  dueAt: Date | null;
  caseId: CaseId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const WORKFLOW_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type WorkflowPriority = (typeof WORKFLOW_PRIORITIES)[number];

// --- tasks -----------------------------------------------------------------

export const WORKFLOW_TASK_STATUSES = [
  /** Created, in a pool, nobody assigned. */
  'open',
  /** Assigned to somebody who has not picked it up. */
  'assigned',
  /** Pulled from a pool by an eligible user. */
  'claimed',
  'in_progress',
  'completed',
  'rejected',
  'cancelled',
  /** Passed its deadline without completion. */
  'expired',
] as const;

export type WorkflowTaskStatus = (typeof WORKFLOW_TASK_STATUSES)[number];

/** Statuses from which no further work is possible. */
export const TERMINAL_TASK_STATUSES: readonly WorkflowTaskStatus[] = [
  'completed',
  'rejected',
  'cancelled',
  'expired',
];

export interface WorkflowTaskRecord {
  id: WorkflowTaskId;
  organizationId: string;
  workflowInstanceId: WorkflowInstanceId;
  /** The step in the definition that produced this task. */
  stepKey: string;
  title: string;
  description: string;
  status: WorkflowTaskStatus;
  priority: WorkflowPriority;
  /**
   * Exactly one of the three is the authority, resolved at creation:
   * a named user, everyone holding a role, or a group's members.
   */
  assigneeUserId: string | null;
  assigneeRole: string | null;
  assigneeGroupId: string | null;
  dueAt: Date | null;
  slaStatus: SlaStatus | null;
  claimedById: string | null;
  claimedAt: Date | null;
  completedById: string | null;
  completedAt: Date | null;
  /** What the completing actor decided. `approve`, `reject`, `return_for_rework`. */
  outcome: string | null;
  delegatedById: string | null;
  delegatedAt: Date | null;
  /** Optimistic lock. This is what makes a pooled claim safe. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// --- decisions -------------------------------------------------------------

export const WORKFLOW_DECISIONS = [
  'approve',
  'reject',
  'return_for_rework',
  /** Recorded when an approver declines to act, e.g. a conflict of interest. */
  'abstain',
] as const;

export type WorkflowDecisionOutcome = (typeof WORKFLOW_DECISIONS)[number];

/**
 * One approver's decision. Append-only.
 *
 * A returned or rejected decision is never deleted, including after a rework
 * cycle. The point of an approval trail is that it shows what was decided
 * before, not only what was decided last.
 */
export interface WorkflowDecisionRecord {
  id: string;
  organizationId: string;
  workflowInstanceId: WorkflowInstanceId;
  workflowTaskId: WorkflowTaskId | null;
  stepKey: string;
  /**
   * Which approver slot this decision filled.
   *
   * Needed for two things a bare actor id cannot answer: whether a unanimous step
   * still has an empty slot, and — for an auditor — *which* of several required
   * reviews this signature was. "Approved by user_9f2" is much less useful than
   * "the Compliance Officer slot was filled by user_9f2".
   *
   * Null for a rejection or a return, which settle the step without filling a slot.
   */
  approverKey: string | null;
  actorId: string;
  actorType: ActorType;
  /** The role the actor acted under, resolved server-side. */
  actorRole: string | null;
  decision: WorkflowDecisionOutcome;
  /** Required for a rejection or a return. A rejection with no reason is unusable. */
  reasonCode: string | null;
  explanation: string | null;
  /** Connects this decision to the authorization decision that permitted it. */
  policyDecisionId: string | null;
  /** Which rework cycle this decision belongs to. */
  reworkCycle: number;
  decidedAt: Date;
}

// --- history ---------------------------------------------------------------

export const WORKFLOW_EVENT_TYPES = [
  'workflow.started',
  'workflow.transitioned',
  'workflow.completed',
  'workflow.cancelled',
  'workflow.returned_for_rework',
  'task.created',
  'task.assigned',
  'task.claimed',
  'task.released',
  'task.reassigned',
  'task.completed',
  'task.expired',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'sla.warning',
  'sla.breached',
  'escalation.triggered',
  'comment.added',
  'comment.amended',
  'attachment.added',
  'attachment.removed',
  'case.opened',
  'case.updated',
  'case.resolved',
  'case.closed',
  'definition.created',
  'definition.updated',
  'definition.submitted_for_approval',
  'definition.approved',
  'definition.published',
  'definition.retired',
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/**
 * One entry in a workflow's history. Append-only, and never deleted.
 *
 * `sequence` is monotonic per instance, so a reader can order events without
 * relying on timestamps — two events in the same transaction can share a
 * millisecond, and a history that reorders itself under load is not a history.
 */
export interface WorkflowEventRecord {
  id: string;
  organizationId: string;
  workflowInstanceId: WorkflowInstanceId | null;
  caseId: CaseId | null;
  workflowTaskId: WorkflowTaskId | null;
  sequence: number;
  type: WorkflowEventType;
  actorId: string | null;
  actorType: ActorType | null;
  fromState: WorkflowState | null;
  toState: WorkflowState | null;
  action: WorkflowAction | null;
  /** The authorization decision that permitted this. Null for system events. */
  policyDecisionId: string | null;
  requestId: string | null;
  /** Non-sensitive metadata only. Redacted before it is written. */
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}

// --- comments --------------------------------------------------------------

export const COMMENT_VISIBILITIES = [
  'participants',
  'approvers',
  'administrators',
  /** Never shown to anyone outside the operating organization. */
  'internal',
  /** Shared with an external participant, e.g. the merchant under review. */
  'external',
] as const;

export type CommentVisibility = (typeof COMMENT_VISIBILITIES)[number];

export interface WorkflowCommentRecord {
  id: string;
  organizationId: string;
  workflowInstanceId: WorkflowInstanceId | null;
  caseId: CaseId | null;
  workflowTaskId: WorkflowTaskId | null;
  stepKey: string | null;
  authorId: string;
  authorActorType: ActorType;
  message: string;
  visibility: CommentVisibility;
  /**
   * Amendment count. Editing a comment writes a `WorkflowCommentAmendment` and
   * increments this — there is no silent edit, because a comment that can change
   * without trace is not evidence.
   */
  amendmentCount: number;
  redactedAt: Date | null;
  redactedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The previous text of an amended comment. Append-only. */
export interface WorkflowCommentAmendmentRecord {
  id: string;
  workflowCommentId: string;
  organizationId: string;
  previousMessage: string;
  amendedById: string;
  reason: string | null;
  amendedAt: Date;
}

// --- attachments -----------------------------------------------------------

export const ATTACHMENT_CLASSIFICATIONS = [
  'supporting_evidence',
  'identity_document',
  'financial_record',
  'correspondence',
  'internal_analysis',
  'other',
] as const;

export type AttachmentClassification = (typeof ATTACHMENT_CLASSIFICATIONS)[number];

export const SCAN_STATUSES = ['not_scanned', 'pending', 'clean', 'infected', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/**
 * A reference to a document, not the bytes.
 *
 * Storage belongs to the document and file-storage modules. This table records
 * that a document is evidence for a workflow, who attached it and what it is —
 * so revoking an attachment does not delete a document that another workflow
 * also references.
 */
export interface WorkflowAttachmentRecord {
  id: string;
  organizationId: string;
  workflowInstanceId: WorkflowInstanceId | null;
  caseId: CaseId | null;
  workflowTaskId: WorkflowTaskId | null;
  stepKey: string | null;
  documentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** SHA-256 of the content, recorded at attach time and re-checkable later. */
  checksum: string;
  classification: AttachmentClassification;
  /** Always `not_scanned` in this phase. The hook is documented, not implemented. */
  scanStatus: ScanStatus;
  attachedById: string;
  attachedAt: Date;
  removedAt: Date | null;
  removedById: string | null;
}

// --- SLA -------------------------------------------------------------------

export const SLA_STATUSES = [
  /** The clock has not started. */
  'pending',
  'active',
  'warning',
  'breached',
  /** Stopped, e.g. waiting on an external party. Elapsed time does not count. */
  'paused',
  'completed',
] as const;

export type SlaStatus = (typeof SLA_STATUSES)[number];

export const SLA_KINDS = [
  'time_to_acknowledge',
  'time_to_claim',
  'time_to_complete',
  'total_duration',
] as const;

export type SlaKind = (typeof SLA_KINDS)[number];

export const SLA_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SlaSeverity = (typeof SLA_SEVERITIES)[number];

export interface WorkflowSlaRecord {
  id: string;
  organizationId: string;
  workflowInstanceId: WorkflowInstanceId | null;
  workflowTaskId: WorkflowTaskId | null;
  stepKey: string | null;
  kind: SlaKind;
  status: SlaStatus;
  severity: SlaSeverity;
  /** Reference into the calendar registry. `elapsed` is the default. */
  calendarId: string;
  durationSeconds: number;
  warningAtSeconds: number;
  startedAt: Date;
  /** Deadline, computed by the calendar at start. */
  dueAt: Date;
  warningAt: Date;
  warnedAt: Date | null;
  breachedAt: Date | null;
  pausedAt: Date | null;
  /** Total paused time, subtracted from elapsed. */
  pausedSeconds: number;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- escalation ------------------------------------------------------------

export const ESCALATION_ACTIONS = [
  'notify_assignee',
  'notify_supervisor',
  'reassign_task',
  'add_approver',
  'increase_priority',
  'create_incident',
  'callback',
] as const;

export type EscalationActionType = (typeof ESCALATION_ACTIONS)[number];

export const ESCALATION_TRIGGERS = ['sla_warning', 'sla_breach', 'manual', 'rework_limit'] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export interface WorkflowEscalationRecord {
  id: string;
  organizationId: string;
  workflowInstanceId: WorkflowInstanceId | null;
  workflowTaskId: WorkflowTaskId | null;
  workflowSlaId: string | null;
  trigger: EscalationTrigger;
  action: EscalationActionType;
  /**
   * What makes an escalation idempotent.
   *
   * Derived from the target and the trigger, and unique — so a scheduler that
   * runs twice, or two schedulers that both notice the same breach, produce one
   * escalation. Without it, an SLA breach at 3am pages somebody every minute
   * until the queue drains.
   */
  idempotencyKey: string;
  status: 'pending' | 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  lastError: string | null;
  /** Non-sensitive. Never a notification body. */
  detail: Record<string, unknown> | null;
  triggeredAt: Date;
  completedAt: Date | null;
}

// --- cases -----------------------------------------------------------------

export const CASE_STATUSES = [
  'open',
  'under_review',
  'waiting_for_information',
  'escalated',
  'resolved',
  'closed',
  'cancelled',
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Statuses from which a case does no further work. */
export const TERMINAL_CASE_STATUSES: readonly CaseStatus[] = ['closed', 'cancelled'];

export interface CaseRecord {
  id: CaseId;
  organizationId: string;
  /** `merchant_onboarding`, `complaint`, `compliance_review`. Product-defined. */
  caseType: string;
  reference: string;
  subject: string;
  description: string;
  status: CaseStatus;
  priority: WorkflowPriority;
  ownerId: string | null;
  assignedTeam: string | null;
  /** Generic business-object reference, same convention as an instance. */
  businessObjectType: string | null;
  businessObjectId: string | null;
  dueAt: Date | null;
  resolution: string | null;
  resolutionCode: string | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
  closureReason: string | null;
  closedById: string | null;
  closedAt: Date | null;
  version: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

// --- idempotency -----------------------------------------------------------

/**
 * A recorded external operation.
 *
 * The request hash is what makes a replayed key safe: the same key with the same
 * payload returns the first result, and the same key with a *different* payload is
 * refused. Returning the first result for a different payload would be worse than
 * either — the caller would believe an operation happened that never did.
 */
export interface IdempotencyRecord {
  id: string;
  organizationId: string;
  idempotencyKey: string;
  actorId: string;
  operation: string;
  requestHash: string;
  /** Where the result lives, e.g. `workflow_instance:wfi_123`. Never a payload. */
  responseReference: string | null;
  status: 'in_progress' | 'completed' | 'failed';
  expiresAt: Date;
  createdAt: Date;
  completedAt: Date | null;
}

// --- persistence boundary --------------------------------------------------

/**
 * A record as a database client returns it.
 *
 * Every narrowed union in this file — `status`, `kind`, `severity`, `visibility`,
 * `classification` — is stored as text, and a generated Prisma client types those columns
 * as `string`. A Json column comes back as a `JsonValue`, which is not assignable to
 * `Record<string, unknown>` either.
 *
 * The consequence is concrete and cost several compiler errors to learn: a store port that
 * names the *narrowed* type is not structurally assignable from the client it exists to
 * accept. So a port declares `DatabaseRow<T>` and the store narrows on the way out.
 *
 * The narrowing is a cast, because the value genuinely is what the schema says and
 * TypeScript cannot prove it. What matters is that the cast lives in **one documented place
 * per table** rather than being sprinkled through the callers — and that a store which can
 * cheaply check a value does so, as `PrismaHistoryStore` does for the event type.
 */
export type DatabaseRow<T> = {
  [K in keyof T]: T[K] extends Record<string, unknown> | null
    ? unknown
    : T[K] extends Record<string, unknown>
      ? unknown
      : null extends T[K]
        ? T[K] extends string | null
          ? string | null
          : T[K]
        : T[K] extends string
          ? string
          : T[K];
};

/**
 * A grouped count, as an injected adapter.
 *
 * A function rather than a delegate method, because Prisma's generated `groupBy` is generic
 * over its own argument *and* return types and no hand-written signature is assignable from
 * it. Asking for a function lets the composition root supply
 * `(args) => prisma.workflowTask.groupBy(args as never)` — one cast, in one place, visible.
 *
 * A method on the port would have needed a cast at the *call* site of every store, which is
 * the same unsafety spread thinner.
 */
export type GroupedCount = (args: {
  by: string[];
  where: Record<string, unknown>;
}) => Promise<Array<Record<string, unknown>>>;
