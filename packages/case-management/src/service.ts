import { ApiError } from '@trustsystem/errors';
import type { SecurityEventEmitter } from '@trustsystem/security-events';
import {
  actorHasPermission,
  crossTenant,
  staleVersion,
  TERMINAL_CASE_STATUSES,
  WORKFLOW_PERMISSIONS,
  type CaseRecord,
  type CaseStatus,
  type WorkflowActor,
  type WorkflowInstanceRecord,
  type WorkflowPriority,
} from '@trustsystem/workflow-core';
import type { HistoryRecorder } from '@trustsystem/workflow-history';

/**
 * Cases.
 *
 * A case is the *container* a workflow runs inside, and the distinction is worth being
 * precise about because it decides what belongs where.
 *
 * A **workflow instance** is one governed process with a defined shape: states,
 * transitions, approvals. It knows how it ends.
 *
 * A **case** is a piece of work somebody owns until it is resolved. Its shape is not
 * known in advance — a complaint may need one review, or three reviews and a refund and a
 * regulatory notification. So a case has an owner, a status, a timeline and any number of
 * workflow instances, and it closes when a person says it is closed rather than when a
 * state machine reaches a terminal state.
 *
 * That is why the status set is `open → under_review → waiting_for_information →
 * escalated → resolved → closed` rather than a definition-driven machine. The transitions
 * between them are deliberately loose: real case work goes backwards, and a case that
 * could not return from `waiting_for_information` to `under_review` would be a case
 * somebody closes and reopens as a duplicate.
 *
 * What is *not* loose is closure. A case closes only from `resolved`, and resolving needs
 * a resolution — because "closed" with no record of what was decided is the state that
 * makes a case system useless six months later.
 */

export interface CaseListQuery {
  organizationId: string;
  status?: CaseStatus[];
  caseType?: string[];
  ownerId?: string;
  assignedTeam?: string;
  priority?: WorkflowPriority[];
  businessObjectType?: string;
  businessObjectId?: string;
  /** Cases past their due date. For an overdue queue. */
  dueBefore?: Date;
  page: number;
  pageSize: number;
}

export interface CaseStore {
  findById(id: string, organizationId: string): Promise<CaseRecord | null>;
  findByReference(reference: string, organizationId: string): Promise<CaseRecord | null>;
  create(
    input: Omit<CaseRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  ): Promise<CaseRecord>;

  /** Conditional update. Null on a version mismatch — the optimistic lock. */
  update(input: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    patch: Partial<CaseRecord>;
  }): Promise<CaseRecord | null>;

  list(
    query: CaseListQuery,
  ): Promise<{ items: CaseRecord[]; total: number; page: number; pageSize: number }>;

  /** Workflow instances linked to a case. */
  listInstances(caseId: string, organizationId: string): Promise<WorkflowInstanceRecord[]>;

  /** Counts by status, for a dashboard tile. Avoids paging to produce a number. */
  countByStatus(organizationId: string): Promise<Array<{ status: CaseStatus; count: number }>>;
}

/**
 * Status transitions.
 *
 * Loose on purpose everywhere except closure. Case work genuinely moves backwards — a
 * resolved case reopens when the customer replies, a case waiting for information returns
 * to review when it arrives — and a machine that forbade it would be worked around by
 * closing and re-raising, which loses the history.
 *
 * The two rules that are tight:
 *
 *   * `closed` is reachable only from `resolved`. A case cannot be closed without a
 *     recorded resolution.
 *   * `closed` and `cancelled` are terminal. Reopening means a new case that references
 *     this one, so the original closure stands in the record.
 */
const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ['under_review', 'waiting_for_information', 'escalated', 'resolved', 'cancelled'],
  under_review: ['waiting_for_information', 'escalated', 'resolved', 'open', 'cancelled'],
  waiting_for_information: ['under_review', 'escalated', 'resolved', 'cancelled'],
  escalated: ['under_review', 'waiting_for_information', 'resolved', 'cancelled'],
  // A resolved case reopens if the resolution turns out to be wrong. That is normal, and
  // the resolution record stays.
  resolved: ['closed', 'under_review', 'open'],
  closed: [],
  cancelled: [],
};

export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

export interface CaseServiceOptions {
  store: CaseStore;
  history: HistoryRecorder;
  events?: SecurityEventEmitter;
  /** Generates the human-facing reference. Defaults to `CASE-<n>` per organization. */
  reference?: (input: { organizationId: string; caseType: string }) => Promise<string>;
  now?: () => Date;
}

export interface OpenCaseInput {
  caseType: string;
  subject: string;
  description: string;
  priority?: WorkflowPriority;
  ownerId?: string | null;
  assignedTeam?: string | null;
  businessObjectType?: string | null;
  businessObjectId?: string | null;
  dueAt?: Date | null;
}

export class CaseService {
  private readonly now: () => Date;

  constructor(private readonly options: CaseServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async open(actor: WorkflowActor, input: OpenCaseInput): Promise<CaseRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.CASE_CREATE.key)) {
      throw ApiError.forbidden('Opening a case requires case.create.');
    }

    const subject = input.subject.trim();
    if (!subject) {
      throw ApiError.validation(
        [{ path: 'subject', message: 'A case needs a subject.' }],
        'A case needs a subject.',
      );
    }

    const reference = this.options.reference
      ? await this.options.reference({
          organizationId: actor.organizationId,
          caseType: input.caseType,
        })
      : `CASE-${Date.now().toString(36).toUpperCase()}`;

    const record = await this.options.store.create({
      organizationId: actor.organizationId,
      caseType: input.caseType,
      reference,
      subject,
      description: input.description.trim(),
      status: 'open',
      priority: input.priority ?? 'normal',
      // Unowned by default. An owner assigned at creation to whoever happened to open it
      // is an owner nobody chose, and "assigned to the person who raised it" is how a
      // case queue stops working.
      ownerId: input.ownerId ?? null,
      assignedTeam: input.assignedTeam ?? null,
      businessObjectType: input.businessObjectType ?? null,
      businessObjectId: input.businessObjectId ?? null,
      dueAt: input.dueAt ?? null,
      resolution: null,
      resolutionCode: null,
      resolvedById: null,
      resolvedAt: null,
      closureReason: null,
      closedById: null,
      closedAt: null,
      createdById: actor.userId,
    });

    await this.options.history.record({
      type: 'case.opened',
      organizationId: actor.organizationId,
      caseId: record.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      toState: 'open',
      metadata: {
        caseType: input.caseType,
        reference,
        priority: record.priority,
        businessObjectType: input.businessObjectType ?? null,
        businessObjectId: input.businessObjectId ?? null,
      },
    });

    return record;
  }

  async find(actor: WorkflowActor, caseId: string): Promise<CaseRecord> {
    const record = await this.options.store.findById(caseId, actor.organizationId);
    // Not found rather than forbidden: a 403 would confirm the case exists in another
    // organization, and a case reference is guessable.
    if (!record) throw crossTenant();
    return record;
  }

  list(actor: WorkflowActor, query: Omit<CaseListQuery, 'organizationId'>) {
    return this.options.store.list({
      ...query,
      organizationId: actor.organizationId,
      pageSize: Math.min(Math.max(query.pageSize, 1), 100),
    });
  }

  /**
   * Updates the mutable fields.
   *
   * Owner, team, priority, due date and description. Deliberately **not** the status:
   * status changes go through `changeStatus`, which validates the transition and records
   * a history entry. A generic update that also moved the status would let a status change
   * happen without either.
   */
  async update(
    actor: WorkflowActor,
    caseId: string,
    input: {
      expectedVersion?: number;
      ownerId?: string | null;
      assignedTeam?: string | null;
      priority?: WorkflowPriority;
      dueAt?: Date | null;
      subject?: string;
      description?: string;
    },
  ): Promise<CaseRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.CASE_UPDATE.key)) {
      throw ApiError.forbidden('Updating a case requires case.update.');
    }

    const record = await this.find(actor, caseId);
    this.assertOpen(record);

    if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) {
      throw staleVersion({ expected: input.expectedVersion, actual: record.version });
    }

    const patch: Partial<CaseRecord> = {};
    const changed: string[] = [];

    if (input.ownerId !== undefined && input.ownerId !== record.ownerId) {
      patch.ownerId = input.ownerId;
      changed.push('ownerId');
    }
    if (input.assignedTeam !== undefined && input.assignedTeam !== record.assignedTeam) {
      patch.assignedTeam = input.assignedTeam;
      changed.push('assignedTeam');
    }
    if (input.priority !== undefined && input.priority !== record.priority) {
      patch.priority = input.priority;
      changed.push('priority');
    }
    if (input.dueAt !== undefined) {
      patch.dueAt = input.dueAt;
      changed.push('dueAt');
    }
    if (input.subject !== undefined && input.subject.trim() !== record.subject) {
      patch.subject = input.subject.trim();
      changed.push('subject');
    }
    if (input.description !== undefined && input.description.trim() !== record.description) {
      patch.description = input.description.trim();
      changed.push('description');
    }

    if (changed.length === 0) return record;

    const updated = await this.applyPatch(actor, record, patch);

    await this.options.history.record({
      type: 'case.updated',
      organizationId: actor.organizationId,
      caseId: record.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      metadata: {
        changed,
        // Ownership changes are named specifically. "Who owned this when it went wrong"
        // is the question a case review asks, and a bare "updated" does not answer it.
        ...(changed.includes('ownerId')
          ? { previousOwnerId: record.ownerId, newOwnerId: input.ownerId ?? null }
          : {}),
      },
    });

    return updated;
  }

  /**
   * Moves a case between statuses.
   *
   * Validates the transition and records it. A reason is required for the two that a
   * reader will ask about: `waiting_for_information` (waiting for what?) and `escalated`
   * (escalated why?). The others are self-explanatory.
   */
  async changeStatus(
    actor: WorkflowActor,
    caseId: string,
    input: { to: CaseStatus; reason?: string; expectedVersion?: number },
  ): Promise<CaseRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.CASE_UPDATE.key)) {
      throw ApiError.forbidden('Changing a case status requires case.update.');
    }

    const record = await this.find(actor, caseId);

    if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) {
      throw staleVersion({ expected: input.expectedVersion, actual: record.version });
    }

    if (input.to === record.status) return record;

    if (input.to === 'resolved') {
      throw ApiError.conflict(
        'Use resolve() to record a resolution. A case cannot become resolved without one.',
        { reason: 'resolution_required' },
      );
    }
    if (input.to === 'closed') {
      throw ApiError.conflict('Use close() to close a case.', { reason: 'closure_required' });
    }

    if (!canTransitionCase(record.status, input.to)) {
      throw ApiError.conflict(
        `A case cannot go from ${record.status} to ${input.to}.` +
          (TERMINAL_CASE_STATUSES.includes(record.status)
            ? ' This case is closed; open a new one that references it.'
            : ` Available: ${CASE_TRANSITIONS[record.status].join(', ')}.`),
        { reason: 'illegal_transition', fromStatus: record.status, toStatus: input.to },
      );
    }

    const needsReason = input.to === 'waiting_for_information' || input.to === 'escalated';
    if (needsReason && !input.reason?.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'reason',
            message:
              input.to === 'waiting_for_information'
                ? 'Say what information the case is waiting for.'
                : 'Say why the case is being escalated.',
          },
        ],
        `Moving a case to ${input.to} requires a reason.`,
      );
    }

    const updated = await this.applyPatch(actor, record, { status: input.to });

    await this.options.history.record({
      type: 'case.updated',
      organizationId: actor.organizationId,
      caseId: record.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      fromState: record.status,
      toState: input.to,
      metadata: { reason: input.reason?.trim() ?? null },
    });

    return updated;
  }

  /**
   * Records a resolution.
   *
   * A resolution code *and* a narrative. The code makes cases countable — "how many
   * complaints were upheld last quarter" — and the narrative is what somebody reads when
   * the same customer complains again. Either alone is insufficient: codes without
   * narrative cannot be understood, narrative without codes cannot be counted.
   */
  async resolve(
    actor: WorkflowActor,
    caseId: string,
    input: { resolutionCode: string; resolution: string; expectedVersion?: number },
  ): Promise<CaseRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.CASE_RESOLVE.key)) {
      throw ApiError.forbidden('Resolving a case requires case.resolve.');
    }

    const record = await this.find(actor, caseId);

    if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) {
      throw staleVersion({ expected: input.expectedVersion, actual: record.version });
    }
    if (!canTransitionCase(record.status, 'resolved')) {
      throw ApiError.conflict(`A ${record.status} case cannot be resolved.`, {
        reason: 'illegal_transition',
        fromStatus: record.status,
      });
    }

    const resolution = input.resolution.trim();
    if (!resolution) {
      throw ApiError.validation(
        [{ path: 'resolution', message: 'A resolution narrative is required.' }],
        'Say what was decided and why.',
      );
    }
    if (!input.resolutionCode.trim()) {
      throw ApiError.validation(
        [{ path: 'resolutionCode', message: 'A resolution code is required.' }],
        'Choose a resolution code so cases can be counted.',
      );
    }

    const updated = await this.applyPatch(actor, record, {
      status: 'resolved',
      resolution,
      resolutionCode: input.resolutionCode.trim(),
      resolvedById: actor.userId,
      resolvedAt: this.now(),
    });

    await this.options.history.record({
      type: 'case.resolved',
      organizationId: actor.organizationId,
      caseId: record.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      fromState: record.status,
      toState: 'resolved',
      metadata: {
        resolutionCode: input.resolutionCode.trim(),
        // The narrative's length rather than its text. It lives on the case row, and a
        // copy in history would be a second version that a later correction does not
        // update — see the same reasoning for comments in `@trustsystem/workflow-history`.
        resolutionLength: resolution.length,
        openForSeconds: Math.round((this.now().getTime() - record.createdAt.getTime()) / 1000),
      },
    });

    return updated;
  }

  /**
   * Closes a resolved case.
   *
   * Terminal. Closure is separate from resolution because they are different acts: the
   * person who decides what to do about a complaint is often not the person who confirms
   * it has been actioned, and collapsing the two loses that.
   */
  async close(
    actor: WorkflowActor,
    caseId: string,
    input: { closureReason: string; expectedVersion?: number },
  ): Promise<CaseRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.CASE_CLOSE.key)) {
      throw ApiError.forbidden('Closing a case requires case.close.');
    }

    const record = await this.find(actor, caseId);

    if (input.expectedVersion !== undefined && input.expectedVersion !== record.version) {
      throw staleVersion({ expected: input.expectedVersion, actual: record.version });
    }

    if (record.status === 'closed') return record;

    if (record.status !== 'resolved') {
      throw ApiError.conflict(
        `A case must be resolved before it is closed. This one is ${record.status}. Closing ` +
          'without a resolution would leave no record of what was decided.',
        { reason: 'illegal_transition', fromStatus: record.status },
      );
    }

    if (!input.closureReason.trim()) {
      throw ApiError.validation(
        [{ path: 'closureReason', message: 'A closure reason is required.' }],
        'Say why the case is being closed.',
      );
    }

    const updated = await this.applyPatch(actor, record, {
      status: 'closed',
      closureReason: input.closureReason.trim(),
      closedById: actor.userId,
      closedAt: this.now(),
    });

    await this.options.history.record({
      type: 'case.closed',
      organizationId: actor.organizationId,
      caseId: record.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      fromState: 'resolved',
      toState: 'closed',
      metadata: {
        closureReason: input.closureReason.trim(),
        resolutionCode: record.resolutionCode,
        totalOpenSeconds: Math.round((this.now().getTime() - record.createdAt.getTime()) / 1000),
      },
    });

    return updated;
  }

  /**
   * Cancels a case.
   *
   * Distinct from closing. A cancelled case was raised in error or superseded; a closed
   * one was worked and resolved. Reporting them as one number would make a team's
   * resolution rate depend on how many duplicates they received.
   */
  async cancel(actor: WorkflowActor, caseId: string, reason: string): Promise<CaseRecord> {
    if (!actorHasPermission(actor, WORKFLOW_PERMISSIONS.CASE_UPDATE.key)) {
      throw ApiError.forbidden('Cancelling a case requires case.update.');
    }
    if (!reason.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'A cancellation reason is required.' }],
        'Say why the case is being cancelled.',
      );
    }

    const record = await this.find(actor, caseId);
    if (record.status === 'cancelled') return record;

    if (!canTransitionCase(record.status, 'cancelled')) {
      throw ApiError.conflict(`A ${record.status} case cannot be cancelled.`, {
        reason: 'illegal_transition',
        fromStatus: record.status,
      });
    }

    const updated = await this.applyPatch(actor, record, {
      status: 'cancelled',
      closureReason: reason.trim(),
      closedById: actor.userId,
      closedAt: this.now(),
    });

    await this.options.history.record({
      type: 'case.closed',
      organizationId: actor.organizationId,
      caseId: record.id,
      actorId: actor.userId,
      actorType: actor.actorType,
      fromState: record.status,
      toState: 'cancelled',
      metadata: { cancelled: true, reason: reason.trim() },
    });

    return updated;
  }

  /** Workflow instances linked to a case. */
  async instances(actor: WorkflowActor, caseId: string): Promise<WorkflowInstanceRecord[]> {
    await this.find(actor, caseId);
    return this.options.store.listInstances(caseId, actor.organizationId);
  }

  /**
   * The case timeline.
   *
   * Paginated, and it deliberately reads from workflow history rather than keeping a
   * timeline of its own. One trail means a case and the workflows inside it are ordered
   * against each other — "escalated, then the approval was returned, then resolved" — and
   * two trails would need merging by timestamp, which is exactly what `sequence` exists
   * to avoid.
   */
  timeline(actor: WorkflowActor, caseId: string, input: { page?: number; pageSize?: number } = {}) {
    return this.options.history.query({
      organizationId: actor.organizationId,
      caseId,
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 25,
    });
  }

  countByStatus(actor: WorkflowActor): Promise<Array<{ status: CaseStatus; count: number }>> {
    return this.options.store.countByStatus(actor.organizationId);
  }

  // --- internals -----------------------------------------------------------

  private assertOpen(record: CaseRecord): void {
    if (TERMINAL_CASE_STATUSES.includes(record.status)) {
      throw ApiError.conflict(
        `This case is ${record.status} and cannot be changed. Open a new case that references it.`,
        { reason: 'case_terminal', status: record.status },
      );
    }
  }

  private async applyPatch(
    actor: WorkflowActor,
    record: CaseRecord,
    patch: Partial<CaseRecord>,
  ): Promise<CaseRecord> {
    const updated = await this.options.store.update({
      id: record.id,
      organizationId: actor.organizationId,
      expectedVersion: record.version,
      patch,
    });

    if (updated) return updated;

    const current = await this.options.store.findById(record.id, actor.organizationId);
    throw staleVersion({ expected: record.version, actual: current?.version ?? -1 });
  }
}

/**
 * Case types the framework names as examples.
 *
 * Examples, not an enumeration: `caseType` is a string and a product defines its own.
 * These exist so the documentation and the example application have something concrete,
 * and none of the business processes behind them is implemented — that is explicitly out
 * of scope for this phase.
 */
export const EXAMPLE_CASE_TYPES = [
  'merchant_onboarding',
  'complaint',
  'compliance_review',
  'operational_exception',
  'fraud_investigation',
  'loan_application_review',
] as const;
