import { ApiError } from '@trustsystem/errors';
import type { WorkflowAction, WorkflowState } from './entities';

/**
 * The workflow failures a caller has to be able to tell apart.
 *
 * Every one of these is a *deliberate* refusal, so each carries a machine-readable
 * `reason` in the error context. That matters more here than in most places: a
 * client that cannot distinguish "you are not allowed" from "somebody else got
 * there first" will retry the wrong one, and a retry of a conflict is a duplicate
 * approval.
 *
 * The 409s are worth reading together. Three different things produce one, and the
 * correct client behaviour differs for each:
 *
 *   * `stale_version` — reload and try again. Somebody changed the record.
 *   * `already_claimed` / `already_completed` — do not retry. Somebody else did it.
 *   * `idempotency_key_reused` — a bug in the caller. Do not retry.
 */

export const WORKFLOW_ERROR_REASONS = [
  'illegal_transition',
  'unknown_action',
  'unknown_state',
  'instance_not_active',
  'stale_version',
  'already_claimed',
  'already_completed',
  'not_assignee',
  'self_approval_forbidden',
  'duplicate_approval',
  'separation_of_duty',
  'approval_incomplete',
  'reason_required',
  'attachment_required',
  'rework_limit_reached',
  'cancellation_not_allowed',
  'definition_immutable',
  'definition_not_published',
  'definition_invalid',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'cross_tenant',
  'condition_invalid',
  'business_object_invalid',
] as const;

export type WorkflowErrorReason = (typeof WORKFLOW_ERROR_REASONS)[number];

/**
 * A transition the definition does not allow from the current state.
 *
 * Reports the actions that *are* available, which is the difference between an
 * error a developer can act on and one they have to reverse-engineer. This is
 * safe to disclose: the definition is not a secret, and the caller is already
 * authenticated and scoped to the instance.
 */
export function illegalTransition(input: {
  from: WorkflowState;
  action: WorkflowAction;
  available: WorkflowAction[];
}): ApiError {
  return ApiError.conflict(
    `The action "${input.action}" is not available from state "${input.from}".`,
    {
      reason: 'illegal_transition' satisfies WorkflowErrorReason,
      fromState: input.from,
      action: input.action,
      availableActions: input.available,
    },
  );
}

/**
 * The record changed between read and write.
 *
 * 409 rather than 500, and with the two version numbers, so a client can decide
 * whether to reload and retry or to surface a conflict to the user. This is the
 * error that prevents a stale decision being applied to a workflow that has since
 * moved on.
 */
export function staleVersion(input: { expected: number; actual: number }): ApiError {
  return ApiError.conflict('This record was changed by somebody else. Reload it and try again.', {
    reason: 'stale_version' satisfies WorkflowErrorReason,
    expectedVersion: input.expected,
    actualVersion: input.actual,
  });
}

/** Somebody else claimed the task first. Not retryable. */
export function alreadyClaimed(claimedById: string | null): ApiError {
  return ApiError.conflict('This task has already been claimed.', {
    reason: 'already_claimed' satisfies WorkflowErrorReason,
    // The claimant's id, so a UI can say who — an unattributed "already claimed"
    // in a shared queue is the start of a conversation on a group chat.
    claimedById,
  });
}

export function alreadyCompleted(): ApiError {
  return ApiError.conflict('This task is already complete.', {
    reason: 'already_completed' satisfies WorkflowErrorReason,
  });
}

/**
 * The maker-checker refusal.
 *
 * 403, and the message says what the rule is rather than only that it was broken:
 * somebody hitting this is usually a legitimate user who does not know the policy,
 * and "you cannot approve your own request" is a complete explanation.
 */
export function selfApprovalForbidden(detail?: string): ApiError {
  return ApiError.forbidden(
    detail ?? 'The actor who submitted this request cannot be its approver.',
    { reason: 'self_approval_forbidden' satisfies WorkflowErrorReason },
  );
}

/** A separation-of-duty rule other than self-approval. */
export function separationOfDutyViolation(rule: string, detail: string): ApiError {
  return ApiError.forbidden(detail, {
    reason: 'separation_of_duty' satisfies WorkflowErrorReason,
    rule,
  });
}

/**
 * The same actor approving the same step twice.
 *
 * Distinct from `self_approval_forbidden`: this actor is a legitimate approver who
 * has already voted. It matters for threshold approvals, where counting one
 * person's two clicks as two approvals would defeat the whole point of "2 of 3".
 */
export function duplicateApproval(stepKey: string): ApiError {
  return ApiError.conflict('You have already recorded a decision on this step.', {
    reason: 'duplicate_approval' satisfies WorkflowErrorReason,
    stepKey,
  });
}

/*
 * The two input failures below are `validation_error` (422) rather than a bespoke
 * 400, because the framework has one code for "your request was not acceptable" and
 * adding a second would mean clients have two things to handle for one situation.
 * The `path` is the field the caller has to fix.
 */

export function reasonRequired(decision: string): ApiError {
  return ApiError.validation(
    [
      {
        path: 'reasonCode',
        message: `A reason is required to ${decision.replace(/_/g, ' ')}.`,
        code: 'reason_required' satisfies WorkflowErrorReason,
      },
    ],
    'A reason is required for this decision.',
  );
}

export function attachmentRequired(stepKey: string, detail: string): ApiError {
  return ApiError.validation(
    [
      {
        path: 'attachments',
        message: detail,
        code: 'attachment_required' satisfies WorkflowErrorReason,
      },
    ],
    `Step "${stepKey}" requires an attachment before a decision can be recorded.`,
  );
}

export function reworkLimitReached(limit: number): ApiError {
  return ApiError.conflict(
    `This request has been returned for rework ${limit} times, which is the configured limit.`,
    { reason: 'rework_limit_reached' satisfies WorkflowErrorReason, limit },
  );
}

/**
 * An attempt to change a published version.
 *
 * The central rule of workflow versioning, so the message says what to do instead
 * rather than only refusing.
 */
export function definitionImmutable(version: string): ApiError {
  return ApiError.conflict(
    `Version ${version} is published and cannot be changed. Create a new version instead.`,
    { reason: 'definition_immutable' satisfies WorkflowErrorReason, version },
  );
}

export function definitionNotPublished(status: string): ApiError {
  return ApiError.conflict(
    `This workflow version is ${status}. Only a published version can start an instance.`,
    { reason: 'definition_not_published' satisfies WorkflowErrorReason, status },
  );
}

/**
 * The same idempotency key with a different payload.
 *
 * A caller bug, so it is a 409 with an explanation rather than a silent replay of
 * the first result. Replaying would tell the caller an operation succeeded that
 * never ran — which is worse than any error.
 */
export function idempotencyKeyReused(key: string): ApiError {
  return ApiError.conflict(
    'This idempotency key was already used for a different request. Use a new key.',
    {
      reason: 'idempotency_key_reused' satisfies WorkflowErrorReason,
      // The key, not the payload: the payload may hold business data and the key
      // is what the caller needs to find in their own logs.
      idempotencyKey: key,
    },
  );
}

/** An operation with this key is running. Retry after it settles. */
export function idempotencyInProgress(key: string): ApiError {
  return ApiError.conflict('An operation with this idempotency key is still in progress.', {
    reason: 'idempotency_in_progress' satisfies WorkflowErrorReason,
    idempotencyKey: key,
  });
}

/**
 * A cross-tenant reach.
 *
 * `notFound`, not `forbidden`. A 403 confirms that the record exists in some other
 * organization, which is the enumeration primitive the tenant boundary exists to
 * deny — see `docs/workflow-security.md`.
 */
export function crossTenant(): ApiError {
  return ApiError.notFound();
}
