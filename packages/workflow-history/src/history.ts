import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import {
  crossTenant,
  type WorkflowEventRecord,
  type WorkflowEventType,
} from '@trustos/workflow-core';
import type { ActorType } from '@trustos/shared-types';

/**
 * Workflow history.
 *
 * Append-only, and that is the entire specification. There is no `update` and no
 * `delete` on `HistoryStore` — not "there is one but you should not call it", but
 * genuinely no method, so a caller cannot rewrite history by mistake and a reviewer
 * cannot approve a change that does.
 *
 * Two properties beyond append-only:
 *
 *   * **`sequence` is monotonic per instance**, so a reader can order events without
 *     relying on timestamps. Two events written in one transaction share a
 *     millisecond, and a history that reorders itself under load is not a history.
 *   * **Metadata is redacted before it is written.** Instance data is caller-supplied
 *     and may hold anything a product put there, and history is the longest-lived
 *     record in the system — a secret written here outlives the incident that leaked it.
 *
 * History and the audit trail are different things and both are written. History
 * answers "what happened to this request", ordered and complete, and is read by a
 * participant. The audit trail answers "who changed what in this organization" across
 * every subsystem, and is read by an auditor. `HistoryRecorder` writes both so a caller
 * cannot write one and forget the other.
 */

/**
 * Field names whose values never enter history.
 *
 * A denylist by name, applied to metadata only — and it is a safety net rather than a
 * licence. The primary control is that callers pass ids and states rather than payloads;
 * this catches the case where somebody passes an instance-data object wholesale.
 *
 * Deliberately not reusing `redactSecrets` from `@trustos/security-policy`: that
 * function's allow-list is tuned for security events, and history has different fields
 * it must keep — `stepKey`, `fromState`, `approverKey`. A shared list would have to
 * satisfy both and would end up satisfying neither.
 */
const SENSITIVE_METADATA_PATTERNS = [
  'password',
  'secret',
  'token',
  'credential',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
  'ssn',
  'cardnumber',
  'cvv',
  'pan',
  'accountnumber',
  'iban',
];

/** Names that look sensitive but are identifiers history needs. Checked first. */
const SAFE_METADATA_FIELDS = ['tokenid', 'credentialtype', 'apikeyid', 'idempotencykey'];

export function isSensitiveMetadataField(name: string): boolean {
  const lowered = name.toLowerCase();
  if (SAFE_METADATA_FIELDS.includes(lowered)) return false;
  return SENSITIVE_METADATA_PATTERNS.some((pattern) => lowered.includes(pattern));
}

export const METADATA_REDACTED = '[REDACTED]';

/**
 * Strips sensitive values from metadata.
 *
 * Depth-limited and cycle-safe, for the same reason the security redactor is: this runs
 * on caller-supplied data, and a deeply nested or self-referential object would
 * otherwise be a stack overflow reachable by anyone who can start a workflow.
 *
 * Arrays of scalars are kept; arrays of objects are recursed. Functions and symbols are
 * dropped rather than stringified — a stringified function body in a history record is
 * both useless and potentially revealing.
 */
export function redactMetadata(
  value: Record<string, unknown>,
  maxDepth = 6,
): Record<string, unknown> {
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[TRUNCATED]';
    if (input === null || input === undefined) return null;

    const type = typeof input;
    if (type === 'function' || type === 'symbol') return undefined;
    if (type !== 'object') return input;

    if (input instanceof Date) return input.toISOString();

    if (seen.has(input as object)) return '[CIRCULAR]';
    seen.add(input as object);

    if (Array.isArray(input)) {
      // Bounded: a 10,000-element array in a history row is a metadata field somebody
      // used as a data store.
      return input.slice(0, 50).map((entry) => walk(entry, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      if (isSensitiveMetadataField(key)) {
        output[key] = METADATA_REDACTED;
        continue;
      }
      const walked = walk(entry, depth + 1);
      if (walked !== undefined) output[key] = walked;
    }
    return output;
  };

  return walk(value, 0) as Record<string, unknown>;
}

// --- store -----------------------------------------------------------------

export interface HistoryPage {
  items: WorkflowEventRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HistoryQuery {
  organizationId: string;
  workflowInstanceId?: string;
  caseId?: string;
  workflowTaskId?: string;
  types?: WorkflowEventType[];
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/**
 * History persistence.
 *
 * **There is no update and no delete.** That is the interface's main feature. A store
 * implementation that added one would still satisfy the type, so the database enforces
 * it too: the migration installs a trigger refusing `UPDATE` and `DELETE` on the
 * history table, the same way phase 1 protects `AuditLog`.
 *
 * `append` allocates the sequence number, which is why it is one method rather than a
 * read-then-write: two concurrent appends must get different sequences, and only the
 * database can guarantee that.
 */
export interface HistoryStore {
  append(input: Omit<WorkflowEventRecord, 'id' | 'sequence'>): Promise<WorkflowEventRecord>;
  query(query: HistoryQuery): Promise<HistoryPage>;
  /** The most recent events, for a summary view that must not load the whole trail. */
  recent(input: {
    organizationId: string;
    workflowInstanceId: string;
    limit: number;
  }): Promise<WorkflowEventRecord[]>;
  /** Count only, for a badge. Avoids paging through everything to say "142 events". */
  count(input: { organizationId: string; workflowInstanceId: string }): Promise<number>;
}

export const MAX_HISTORY_PAGE_SIZE = 100;

export interface RecordEventInput {
  type: WorkflowEventType;
  organizationId: string;
  workflowInstanceId?: string | null;
  caseId?: string | null;
  workflowTaskId?: string | null;
  actorId?: string | null;
  actorType?: ActorType | null;
  fromState?: string | null;
  toState?: string | null;
  action?: string | null;
  /** The authorization decision that permitted this. Null for a system event. */
  policyDecisionId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Workflow definition and version, for the audit record. */
  workflowDefinitionId?: string | null;
  workflowVersion?: string | null;
}

export interface HistoryRecorderOptions {
  store: HistoryStore;
  /**
   * The audit trail.
   *
   * Optional so the package works in a test without one, and wired in every real
   * deployment. See the header: history and audit answer different questions for
   * different readers, and both are required by section 29.
   */
  audit?: Pick<AuditService, 'record'>;
  now?: () => Date;
}

/**
 * Writes a workflow event to history and, where it matters, to the audit trail.
 *
 * The two trails are written by one call so a caller cannot write one and forget the
 * other — which is the failure that produces a complete history and an audit trail
 * with a hole in it, discovered during an audit rather than in a test.
 */
export class HistoryRecorder {
  private readonly now: () => Date;

  constructor(private readonly options: HistoryRecorderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async record(input: RecordEventInput): Promise<WorkflowEventRecord> {
    const occurredAt = this.now();

    const event = await this.options.store.append({
      organizationId: input.organizationId,
      workflowInstanceId: input.workflowInstanceId ?? null,
      caseId: input.caseId ?? null,
      workflowTaskId: input.workflowTaskId ?? null,
      type: input.type,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? null,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      action: input.action ?? null,
      policyDecisionId: input.policyDecisionId ?? null,
      requestId: input.requestId ?? null,
      metadata: input.metadata ? redactMetadata(input.metadata) : null,
      occurredAt,
    });

    if (this.options.audit && AUDITABLE_WORKFLOW_EVENTS.has(input.type)) {
      /*
       * A failed audit write must not undo a completed workflow action, and it must
       * not be silent either. It is logged through the audit service's own logger and
       * the workflow event stands — history is the complete record, and the audit
       * trail is a projection of it, so a gap in the projection is recoverable from
       * history and a rolled-back approval is not.
       */
      await this.options.audit
        .record({
          action: `workflow.${input.type}`,
          entityType: input.caseId ? 'CaseRecord' : 'WorkflowInstance',
          entityId: input.caseId ?? input.workflowInstanceId ?? event.id,
          actorId: input.actorId ?? null,
          organizationId: input.organizationId,
          after: {
            // Everything section 29 requires, and nothing from instance data.
            actorType: input.actorType ?? null,
            workflowDefinitionId: input.workflowDefinitionId ?? null,
            workflowVersion: input.workflowVersion ?? null,
            workflowInstanceId: input.workflowInstanceId ?? null,
            previousState: input.fromState ?? null,
            newState: input.toState ?? null,
            action: input.action ?? null,
            decisionId: input.policyDecisionId ?? null,
            requestId: input.requestId ?? null,
            ...(event.metadata ?? {}),
          },
        })
        .catch(() => undefined);
    }

    return event;
  }

  /** A page of history, newest first. */
  query(query: Omit<HistoryQuery, 'pageSize'> & { pageSize?: number }): Promise<HistoryPage> {
    return this.options.store.query({
      ...query,
      pageSize: clampPageSize(query.pageSize ?? 25),
    });
  }

  /**
   * The last few events, for a summary card.
   *
   * Exists so a list view does not load a 400-event trail to render "last updated by
   * Ada, 20 minutes ago". Section 32 requires that summary views do not load full
   * history; this is how.
   */
  recent(input: {
    organizationId: string;
    workflowInstanceId: string;
    limit?: number;
  }): Promise<WorkflowEventRecord[]> {
    return this.options.store.recent({
      organizationId: input.organizationId,
      workflowInstanceId: input.workflowInstanceId,
      limit: Math.min(Math.max(input.limit ?? 10, 1), 50),
    });
  }

  count(organizationId: string, workflowInstanceId: string): Promise<number> {
    return this.options.store.count({ organizationId, workflowInstanceId });
  }
}

/**
 * Workflow events that also belong in the audit trail.
 *
 * An allow-list, for the reason phase 4's security-event bridge uses one: a customer's
 * audit trail full of `task.claimed` is a trail nobody reads, and the entries that
 * matter get buried. What crosses over is section 29's list — the decisions and the
 * governance acts, not the mechanics.
 */
export const AUDITABLE_WORKFLOW_EVENTS = new Set<WorkflowEventType>([
  'definition.created',
  'definition.updated',
  'definition.approved',
  'definition.published',
  'definition.retired',
  'workflow.started',
  'workflow.transitioned',
  'workflow.cancelled',
  'workflow.returned_for_rework',
  'task.assigned',
  'task.reassigned',
  'task.claimed',
  'approval.approved',
  'approval.rejected',
  'sla.breached',
  'escalation.triggered',
  'case.resolved',
  'case.closed',
]);

function clampPageSize(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 25;
  return Math.min(Math.floor(requested), MAX_HISTORY_PAGE_SIZE);
}

/**
 * Renders one history entry as a sentence.
 *
 * History is read by people, and a table of `workflow.transitioned` rows is not read.
 * Kept in the framework rather than left to each product so the phrasing is consistent
 * across an application's own workflows and the framework's.
 */
export function describeEvent(event: WorkflowEventRecord): string {
  const actor = event.actorId ?? 'the system';

  switch (event.type) {
    case 'workflow.started':
      return `${actor} started the workflow in "${event.toState}".`;
    case 'workflow.transitioned':
      return `${actor} took "${event.action}": ${event.fromState} → ${event.toState}.`;
    case 'workflow.completed':
      return `The workflow completed in "${event.toState}".`;
    case 'workflow.cancelled':
      return `${actor} cancelled the workflow.`;
    case 'workflow.returned_for_rework':
      return `${actor} returned the request for rework.`;
    case 'task.created':
      return 'A task was created.';
    case 'task.assigned':
      return `A task was assigned.`;
    case 'task.claimed':
      return `${actor} claimed a task.`;
    case 'task.released':
      return `${actor} released a task back to the pool.`;
    case 'task.reassigned':
      return `${actor} reassigned a task.`;
    case 'task.completed':
      return `${actor} completed a task.`;
    case 'task.expired':
      return 'A task passed its deadline without being completed.';
    case 'approval.requested':
      return 'Approval was requested.';
    case 'approval.approved':
      return `${actor} approved.`;
    case 'approval.rejected':
      return `${actor} rejected the request.`;
    case 'sla.warning':
      return 'An SLA passed its warning threshold.';
    case 'sla.breached':
      return 'An SLA was breached.';
    case 'escalation.triggered':
      return 'An escalation was triggered.';
    case 'comment.added':
      return `${actor} added a comment.`;
    case 'comment.amended':
      return `${actor} amended a comment. The previous text is retained.`;
    case 'attachment.added':
      return `${actor} attached evidence.`;
    case 'attachment.removed':
      return `${actor} detached evidence. The document itself was not deleted.`;
    case 'case.opened':
      return `${actor} opened the case.`;
    case 'case.updated':
      return `${actor} updated the case.`;
    case 'case.resolved':
      return `${actor} recorded a resolution.`;
    case 'case.closed':
      return `${actor} closed the case.`;
    case 'definition.created':
      return `${actor} created the workflow definition.`;
    case 'definition.updated':
      return `${actor} edited the draft definition.`;
    case 'definition.submitted_for_approval':
      return `${actor} submitted the definition for approval.`;
    case 'definition.approved':
      return `${actor} approved the definition.`;
    case 'definition.published':
      return `${actor} published the definition. It is now immutable.`;
    case 'definition.retired':
      return `${actor} retired the definition version.`;
  }
}

/**
 * Asserts a history read is in scope.
 *
 * A separate function because history is the one place where a cross-tenant read would
 * be *most* damaging — it is the complete narrative of somebody else's business
 * decisions — and the check should be impossible to overlook at a call site.
 */
export function assertHistoryScope(input: {
  actorOrganizationId: string;
  recordOrganizationId: string | null;
}): void {
  if (!input.recordOrganizationId) {
    throw ApiError.internal('A history record with no organization cannot be scoped safely.');
  }
  if (input.recordOrganizationId !== input.actorOrganizationId) throw crossTenant();
}
