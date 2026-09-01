import {
  LIFECYCLE_TRANSITIONS,
  PRODUCT_LIFECYCLE_STATUSES,
  productError,
  type ProductLifecycleStatus,
} from '@trustsystem/financial-product-core';
import { StateMachine, type TransitionRule } from './machine';

/**
 * The governance lifecycle machine.
 *
 * Built from `LIFECYCLE_TRANSITIONS`, which is data in `core` rather than code here — so the
 * table can be read by the admin UI, the documentation generator and a test, none of which
 * should have to instantiate a machine to find out whether a draft can reach production.
 *
 * The machine adds what a table cannot express: reachability, the available-action list an error
 * message offers, and the four preconditions below. Those four are stated as a separate function
 * rather than folded into the transition because they are *facts about the world* — who is
 * acting, what has been approved, whether the definition still hashes to what was reviewed — and
 * a machine that read the world would not be pure.
 */

export type LifecycleAction = string;

export const PRODUCT_LIFECYCLE_MACHINE = new StateMachine<ProductLifecycleStatus, LifecycleAction>(
  'product lifecycle',
  PRODUCT_LIFECYCLE_STATUSES,
  LIFECYCLE_TRANSITIONS.map((transition) => ({
    action: transition.action,
    from: transition.from,
    to: transition.to,
    permission: transition.permission,
    requiresApproval: transition.requiresApproval,
    description: transition.description,
  })),
);

/**
 * What the caller must have established before a transition is applied.
 *
 * Every field is loaded from the database by the caller. None of it comes from a request body,
 * and the type deliberately has no field that could: a client-supplied `approvals` array would
 * make the approval requirement a suggestion.
 */
export interface LifecyclePrecondition {
  /** The actor's permissions, resolved server-side from the membership tables. */
  actorPermissions: readonly string[];
  /** Who authored this version. Compared against the actor for self-approval. */
  authoredById: string | null;
  /** The actor requesting the transition. */
  actorId: string;
  /** Approval levels already recorded for this version, from the decision trail. */
  recordedApprovalLevels: readonly string[];
  /** Approval levels this change requires, from `@trustsystem/financial-product-governance`. */
  requiredApprovalLevels: readonly string[];
  /** Whether the definition still hashes to what was reviewed. */
  definitionUnchanged: boolean;
}

export interface LifecycleCheck {
  allowed: boolean;
  refusals: Array<{
    code: 'missing_permission' | 'self_approval' | 'missing_approval' | 'definition_changed';
    message: string;
  }>;
  transition: TransitionRule<ProductLifecycleStatus, LifecycleAction>;
}

/**
 * Checks a lifecycle transition against the world.
 *
 * Returns every refusal rather than the first, because a product owner who fixes one and
 * resubmits to find a second is a product owner who stops trusting the tool. The runtime asserts
 * on the result; the admin UI shows the list.
 *
 * The self-approval check is the one worth reading twice. It fires on the *approve* action only,
 * and it compares the actor against the recorded author of the version — never against a
 * submitter field in a request. A maker who can approve their own product is not a control; it
 * is a log entry that looks like one.
 */
export function checkLifecycleTransition(
  from: ProductLifecycleStatus,
  action: LifecycleAction,
  precondition: LifecyclePrecondition,
): LifecycleCheck {
  const transition = PRODUCT_LIFECYCLE_MACHINE.assert(from, action);
  const refusals: LifecycleCheck['refusals'] = [];

  if (transition.permission && !precondition.actorPermissions.includes(transition.permission)) {
    refusals.push({
      code: 'missing_permission',
      message: `The actor does not hold "${transition.permission}".`,
    });
  }

  const isApprovalAction = action === 'approve' || action === 'reject';
  if (
    isApprovalAction &&
    precondition.authoredById !== null &&
    precondition.authoredById === precondition.actorId
  ) {
    refusals.push({
      code: 'self_approval',
      message:
        'The actor authored this version. A maker who can approve their own product is not a ' +
        'control; it is a log entry that looks like one.',
    });
  }

  if (transition.requiresApproval) {
    const recorded = new Set(precondition.recordedApprovalLevels);
    const missing = precondition.requiredApprovalLevels.filter((level) => !recorded.has(level));

    if (missing.length > 0) {
      refusals.push({
        code: 'missing_approval',
        message: `Missing approval from: ${missing.join(', ')}.`,
      });
    }
  }

  /*
   * The check that survives a direct database edit.
   *
   * Permissions and approvals are checks on people. This is a check on the artefact: if the
   * definition no longer hashes to what the reviewers saw, their approvals are approvals of a
   * different product. It applies from `under_review` onward, because before that the definition
   * is meant to change.
   */
  const frozen: ProductLifecycleStatus[] = ['under_review', 'approved', 'staged', 'active'];
  if (frozen.includes(from) && !precondition.definitionUnchanged) {
    refusals.push({
      code: 'definition_changed',
      message:
        'The definition no longer matches the hash it was reviewed under. The recorded ' +
        'approvals approve a different product.',
    });
  }

  return { allowed: refusals.length === 0, refusals, transition };
}

/** Applies a transition, or throws with every reason it was refused. */
export function applyLifecycleTransition(
  from: ProductLifecycleStatus,
  action: LifecycleAction,
  precondition: LifecyclePrecondition,
): ProductLifecycleStatus {
  const check = checkLifecycleTransition(from, action, precondition);

  if (!check.allowed) {
    const selfApproval = check.refusals.some((refusal) => refusal.code === 'self_approval');

    throw productError(
      selfApproval ? 'product_self_approval_refused' : 'product_approval_required',
      `Cannot ${action} from "${from}": ${check.refusals.map((refusal) => refusal.message).join(' ')}`,
      { expected: check.transition.to, actual: from },
    );
  }

  return check.transition.to;
}
