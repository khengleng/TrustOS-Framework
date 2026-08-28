import { ApiError } from '@trustos/errors';
import {
  duplicateApproval,
  isSameActor,
  selfApprovalForbidden,
  type WorkflowActor,
  type WorkflowDecisionOutcome,
  type WorkflowDecisionRecord,
} from '@trustos/workflow-core';
import { evaluateCondition, type WorkflowApprovalSpec } from '@trustos/workflow-definition';

/**
 * Approval models.
 *
 * Everything in this file is a **pure function of the decisions already recorded**.
 * There is no state of its own, no database and no clock beyond what is passed in.
 * That is a deliberate shape: approval progress is derived from the decision trail
 * rather than tracked alongside it, so the two cannot disagree.
 *
 * The alternative — a counter on the step that increments per approval — is the
 * design that produces "the instance says 2 of 3 but only one decision exists".
 * Recomputing from the trail means the trail is the truth, which is also what an
 * auditor reads.
 *
 * The six models, and what actually distinguishes them:
 *
 *   single      one decision settles it
 *   parallel    several may act concurrently; the first decision settles it
 *   sequential  a defined order; approver N cannot act before N-1 has
 *   unanimous   every listed approver must approve
 *   threshold   K of N distinct actors must approve
 *   conditional the required set depends on instance data
 *
 * `parallel` and `single` differ only in how many people are *eligible*, which is
 * why they share an evaluation path. Keeping them separate in the definition matters
 * anyway: it tells a reader whether one person is the control or one of several.
 */

export interface ApprovalProgress {
  /** Whether the step's requirement is met. */
  satisfied: boolean;
  /** Whether a rejection settled it. Terminal regardless of `satisfied`. */
  rejected: boolean;
  /** Whether a return-for-rework settled it. */
  returned: boolean;
  /** Distinct approving actors so far. */
  approvals: number;
  /** How many are needed in total. */
  required: number;
  /** Approver slots still outstanding, in the order they may act. */
  outstanding: Array<{ key: string; name: string; permission: string }>;
  /** Approvers skipped because their condition did not hold. */
  skipped: Array<{ key: string; name: string; reason: string }>;
  /** Human-readable state, for a portal and for a history entry. */
  summary: string;
}

export interface EvaluateApprovalInput {
  approval: WorkflowApprovalSpec;
  /**
   * Decisions for this step **and this rework cycle only**.
   *
   * Scoping by cycle is not an optimisation. After a return for rework the maker may
   * change the very fields an approver looked at, so an approval from before the
   * rework is an approval of a different request. Counting it would mean a maker
   * could get one genuine approval, be returned, change the amount, and inherit the
   * approval for the new amount.
   *
   * The runtime filters; this function trusts that it did, and the runtime's tests
   * assert it.
   */
  decisions: WorkflowDecisionRecord[];
  /** Instance data, for conditional approvers. */
  data: Record<string, unknown>;
}

/**
 * Which approvers a conditional model actually requires for this instance.
 *
 * An approver whose condition is false is *skipped*, and skipping is recorded rather
 * than silent: an auditor asking "why did compliance not review this?" needs the
 * answer "because riskRating was medium", not an absence.
 */
export function resolveRequiredApprovers(
  approval: WorkflowApprovalSpec,
  data: Record<string, unknown>,
): {
  required: WorkflowApprovalSpec['approvers'];
  skipped: Array<{ key: string; name: string; reason: string }>;
} {
  const required: WorkflowApprovalSpec['approvers'] = [];
  const skipped: Array<{ key: string; name: string; reason: string }> = [];

  for (const approver of approval.approvers) {
    if (!approver.condition) {
      required.push(approver);
      continue;
    }

    if (evaluateCondition(approver.condition, data)) {
      required.push(approver);
    } else {
      skipped.push({
        key: approver.key,
        name: approver.name,
        reason: 'condition_not_met',
      });
    }
  }

  return { required, skipped };
}

/**
 * How many distinct approvals the model needs.
 *
 * `sequential` and `unanimous` need all of them; `threshold` needs K; `single`,
 * `parallel` and `conditional` need one decision from the eligible population.
 *
 * A `conditional` model is worth a note: the count is one, and the *routing* is what
 * the conditions control. A definition wanting "compliance must also approve when
 * high risk" expresses that as a conditional transition to a second approval step,
 * not as a conditional approver on one step — which is why the change-request
 * example is shaped the way it is.
 */
export function requiredApprovalCount(
  approval: WorkflowApprovalSpec,
  requiredApprovers: WorkflowApprovalSpec['approvers'],
): number {
  switch (approval.model) {
    case 'single':
    case 'parallel':
    case 'conditional':
      return 1;
    case 'threshold':
      return Math.min(approval.threshold ?? 1, Math.max(requiredApprovers.length, 1));
    case 'sequential':
    case 'unanimous':
      return requiredApprovers.length;
  }
}

/**
 * Evaluates a step's approval state from its decision trail.
 *
 * A rejection or a return settles the step immediately, whatever the model. That is
 * not configurable, and it should not be: "three people must approve but one may
 * veto" is how every real approval chain works, and a model where a rejection could
 * be outvoted would mean a reviewer's refusal is advisory.
 */
export function evaluateApproval(input: EvaluateApprovalInput): ApprovalProgress {
  const { approval, decisions, data } = input;
  const { required: requiredApprovers, skipped } = resolveRequiredApprovers(approval, data);
  const required = requiredApprovalCount(approval, requiredApprovers);

  const rejection = decisions.find((decision) => decision.decision === 'reject');
  const returned = decisions.find((decision) => decision.decision === 'return_for_rework');

  if (rejection) {
    return {
      satisfied: false,
      rejected: true,
      returned: false,
      approvals: countDistinctApprovals(decisions, approval),
      required,
      outstanding: [],
      skipped,
      summary: `Rejected by ${rejection.actorId}${
        rejection.reasonCode ? ` (${rejection.reasonCode})` : ''
      }.`,
    };
  }

  if (returned) {
    return {
      satisfied: false,
      rejected: false,
      returned: true,
      approvals: countDistinctApprovals(decisions, approval),
      required,
      outstanding: [],
      skipped,
      summary: `Returned for rework by ${returned.actorId}${
        returned.reasonCode ? ` (${returned.reasonCode})` : ''
      }.`,
    };
  }

  const approvals = countDistinctApprovals(decisions, approval);
  const satisfied = approvals >= required;

  const outstanding = satisfied ? [] : outstandingApprovers(approval, requiredApprovers, decisions);

  return {
    satisfied,
    rejected: false,
    returned: false,
    approvals,
    required,
    outstanding: outstanding.map((approver) => ({
      key: approver.key,
      name: approver.name,
      permission: approver.permission,
    })),
    skipped,
    summary: satisfied
      ? `Approved (${approvals} of ${required}).`
      : `Awaiting ${required - approvals} more approval(s) of ${required}.` +
        (outstanding.length > 0 ? ` Next: ${outstanding[0]?.name}.` : ''),
  };
}

/**
 * Distinct approving actors.
 *
 * Distinct is the operative word. `allowSameActorMultipleSlots` defaults false, so
 * one person clicking approve twice counts once — otherwise "2 of 3" is satisfiable
 * by one person, and a threshold that one person can meet is not a threshold.
 */
function countDistinctApprovals(
  decisions: WorkflowDecisionRecord[],
  approval: WorkflowApprovalSpec,
): number {
  const approvals = decisions.filter((decision) => decision.decision === 'approve');

  if (approval.allowSameActorMultipleSlots) return approvals.length;

  return new Set(approvals.map((decision) => decision.actorId)).size;
}

/**
 * Approver slots still outstanding, in the order they may act.
 *
 * For `sequential`, only the next one is returned — that is what makes it
 * sequential. Returning all of them would let a portal offer the third approver a
 * button before the first has acted, and a portal that offers an action the server
 * will refuse is a portal that teaches people the system is broken.
 */
function outstandingApprovers(
  approval: WorkflowApprovalSpec,
  requiredApprovers: WorkflowApprovalSpec['approvers'],
  decisions: WorkflowDecisionRecord[],
): WorkflowApprovalSpec['approvers'] {
  const approvedActors = new Set(
    decisions.filter((decision) => decision.decision === 'approve').map((d) => d.actorId),
  );
  const approvedCount = approvedActors.size;

  if (approval.model === 'sequential') {
    const ordered = [...requiredApprovers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // Position N is outstanding when N approvals have been recorded, so the next
    // approver is exactly the one at index `approvedCount`.
    const next = ordered[approvedCount];
    return next ? [next] : [];
  }

  if (approval.model === 'unanimous') {
    // Every slot must be filled, so outstanding is the slots nobody has filled.
    // This is what `approverKey` on a decision is for: without it there is no way to
    // tell a filled slot from an unfilled one when two approvers share a permission.
    const filled = new Set(
      decisions
        .filter((decision) => decision.decision === 'approve' && decision.approverKey)
        .map((decision) => decision.approverKey as string),
    );
    return requiredApprovers.filter((approver) => !filled.has(approver.key));
  }

  if (approval.model === 'threshold') {
    // A threshold does not care which slots are filled, only how many distinct
    // actors approved — so every approver who has not personally approved is still a
    // candidate.
    const approvedBy = new Set(
      decisions.filter((decision) => decision.decision === 'approve').map((d) => d.actorId),
    );
    void approvedBy;
    return requiredApprovers;
  }

  return requiredApprovers;
}

// --- eligibility -----------------------------------------------------------

export interface ApproverEligibility {
  eligible: boolean;
  /** Machine-readable, for a security event and a test. */
  reason:
    | 'eligible'
    | 'self_approval_forbidden'
    | 'already_decided'
    | 'missing_permission'
    | 'missing_role'
    | 'not_next_in_sequence'
    | 'no_slot_available'
    | 'already_settled';
  /** The slot the actor would fill. */
  approverKey: string | null;
  detail: string;
}

export interface CheckEligibilityInput {
  approval: WorkflowApprovalSpec;
  actor: WorkflowActor;
  /** Who submitted the request. The maker, for the self-approval check. */
  initiatedById: string;
  decisions: WorkflowDecisionRecord[];
  data: Record<string, unknown>;
}

/**
 * Whether an actor may record a decision on this step.
 *
 * Returns a verdict rather than throwing, because two callers need it for different
 * purposes: the runtime turns a refusal into an error, and the portal uses it to
 * decide what to show. A function that only threw would push the portal into
 * duplicating the logic — and a portal's copy of an authorization rule is a copy
 * that drifts.
 *
 * The order of the checks is deliberate. Self-approval is first, before permissions,
 * because it is the answer that does not change no matter what the actor is granted:
 * telling a maker "you lack the approval permission" when the real reason is "you
 * submitted this" sends them to an administrator for a grant that will not help.
 */
export function checkApproverEligibility(input: CheckEligibilityInput): ApproverEligibility {
  const { approval, actor, initiatedById, decisions, data } = input;

  // Already settled — nothing to be eligible for.
  const settled = decisions.some(
    (decision) => decision.decision === 'reject' || decision.decision === 'return_for_rework',
  );
  if (settled) {
    return {
      eligible: false,
      reason: 'already_settled',
      approverKey: null,
      detail: 'This step already has a final decision.',
    };
  }

  /*
   * Maker-checker. The framework's default and its central control.
   *
   * `isSameActor` rather than `===` so the comparison is findable, and so two null
   * ids do not count as a match — a system-initiated workflow has no initiator, and
   * treating "nobody" as matching "nobody" would silently disable this check on
   * exactly the instances where the bug would be hardest to see.
   */
  if (!approval.allowSelfApproval && isSameActor(actor.userId, initiatedById)) {
    return {
      eligible: false,
      reason: 'self_approval_forbidden',
      approverKey: null,
      detail: 'You submitted this request, so you cannot be its approver.',
    };
  }

  // One decision per actor per step per cycle, unless the definition says otherwise.
  const alreadyDecided = decisions.some((decision) => isSameActor(decision.actorId, actor.userId));
  if (alreadyDecided && !approval.allowSameActorMultipleSlots) {
    return {
      eligible: false,
      reason: 'already_decided',
      approverKey: null,
      detail: 'You have already recorded a decision on this step.',
    };
  }

  const { required } = resolveRequiredApprovers(approval, data);
  if (required.length === 0) {
    return {
      eligible: false,
      reason: 'no_slot_available',
      approverKey: null,
      detail: 'Every approver on this step was skipped by its condition.',
    };
  }

  // Which slot could this actor fill? For a sequential model there is exactly one
  // candidate; for the others, any slot whose permission the actor holds.
  const approvedCount = new Set(
    decisions.filter((decision) => decision.decision === 'approve').map((d) => d.actorId),
  ).size;

  const filledSlots = new Set(
    decisions
      .filter((decision) => decision.decision === 'approve' && decision.approverKey)
      .map((decision) => decision.approverKey as string),
  );

  const candidates =
    approval.model === 'sequential'
      ? (() => {
          // Exactly one candidate, which is what makes it sequential: offering the
          // third approver a button before the first has acted would teach people
          // that the system rejects valid actions.
          const ordered = [...required].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          const next = ordered[approvedCount];
          return next ? [next] : [];
        })()
      : approval.model === 'unanimous'
        ? required.filter((approver) => !filledSlots.has(approver.key))
        : required;

  if (candidates.length === 0) {
    return {
      eligible: false,
      reason: 'no_slot_available',
      approverKey: null,
      detail: 'Every approver slot on this step is filled.',
    };
  }

  const holdsPermission = (permission: string): boolean =>
    actor.permissions.includes('*') || actor.permissions.includes(permission);

  for (const candidate of candidates) {
    if (!holdsPermission(candidate.permission)) continue;
    // A role narrows the population further, for the case where a permission is held
    // by several roles and only one of them should sign this step.
    if (candidate.role && !actor.roles.includes(candidate.role)) continue;

    return {
      eligible: true,
      reason: 'eligible',
      approverKey: candidate.key,
      detail: `Eligible as "${candidate.name}".`,
    };
  }

  // Nothing matched. Report the most useful of the two possible reasons: a missing
  // role when the permission was held, a missing permission otherwise.
  const permissionHeld = candidates.some((candidate) => holdsPermission(candidate.permission));

  if (approval.model === 'sequential' && candidates.length === 1 && !permissionHeld) {
    return {
      eligible: false,
      reason: 'not_next_in_sequence',
      approverKey: null,
      detail:
        `This step is awaiting "${candidates[0]?.name}", which requires ` +
        `"${candidates[0]?.permission}".`,
    };
  }

  return {
    eligible: false,
    reason: permissionHeld ? 'missing_role' : 'missing_permission',
    approverKey: null,
    detail: permissionHeld
      ? 'You hold the permission but not the role this approver slot requires.'
      : `Approving this step requires one of: ${[
          ...new Set(candidates.map((candidate) => candidate.permission)),
        ].join(', ')}.`,
  };
}

/**
 * Asserts eligibility, throwing the right error for each refusal.
 *
 * Self-approval and duplicate approval get their own errors from
 * `@trustos/workflow-core`, because those two are the ones a client has to handle
 * differently: the first is permanent for this actor, the second means somebody
 * clicked twice.
 */
export function assertApproverEligible(input: CheckEligibilityInput): string {
  const verdict = checkApproverEligibility(input);
  if (verdict.eligible) return verdict.approverKey as string;

  switch (verdict.reason) {
    case 'self_approval_forbidden':
      throw selfApprovalForbidden(verdict.detail);
    case 'already_decided':
      throw duplicateApproval('step');
    default:
      throw ApiError.forbidden(verdict.detail, {
        reason: 'approval_incomplete',
        eligibilityReason: verdict.reason,
      });
  }
}

/**
 * The next decision a step is waiting for, for a task list.
 *
 * Returns a description rather than an actor, because for every model except
 * `sequential` the answer is a population and not a person.
 */
export function describeNextApproval(progress: ApprovalProgress): string {
  if (progress.rejected) return 'Rejected.';
  if (progress.returned) return 'Returned for rework.';
  if (progress.satisfied) return 'Fully approved.';

  const remaining = progress.required - progress.approvals;
  if (progress.outstanding.length === 1) {
    return `Awaiting ${progress.outstanding[0]?.name}.`;
  }
  return `Awaiting ${remaining} of ${progress.required} approval(s) from ${
    progress.outstanding.length
  } eligible approver(s).`;
}

/**
 * Whether a decision outcome needs a reason.
 *
 * Reject and return always do; approve never does. A rejection with no reason is
 * unusable by the maker and worthless to an auditor, and "approved" is
 * self-explanatory.
 */
export function decisionRequiresReason(decision: WorkflowDecisionOutcome): boolean {
  return decision === 'reject' || decision === 'return_for_rework' || decision === 'abstain';
}
