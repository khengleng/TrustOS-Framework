import type { AuthorizationRequest, Policy, PolicyResult } from '@trustos/authorization';
import { hasPermission } from '@trustos/rbac';
import {
  isSameActor,
  type WorkflowDecisionRecord,
  type WorkflowInstanceStatus,
} from '@trustos/workflow-core';

/**
 * Workflow authorization policies.
 *
 * These plug into the phase 4 policy engine and inherit its two properties: **default
 * deny**, and **only the last policy can allow**. Every policy here can therefore only
 * refuse — none returns `allow` — so adding one can only make the system stricter.
 *
 * That is why separation of duties lives here rather than inside the runtime. A check
 * in the runtime covers one call path; a policy is evaluated by
 * `PolicyAuthorizationGuard` on every route that declares a workflow action, so an
 * endpoint added next year is covered without anybody remembering.
 *
 * The engine cannot load a workflow record in a guard — a guard runs before the
 * handler — so the runtime calls `authorizer.assert` with the record in hand, passed
 * through `AuthorizationResource.attributes`. `workflowResource()` builds that
 * consistently; hand-assembling it is how a field gets misspelled and a policy
 * silently abstains.
 */

export const WORKFLOW_RESOURCE_TYPES = {
  INSTANCE: 'WorkflowInstance',
  TASK: 'WorkflowTask',
  VERSION: 'WorkflowVersion',
} as const;

/**
 * The workflow facts a policy reads.
 *
 * Every field here is loaded from the database by the runtime. None of it comes from
 * a request body — which is the whole point: a client-supplied `initiatedById` or
 * `currentState` would make every policy below trivially bypassable, and
 * `WorkflowActor` deliberately has no such fields.
 */
export interface WorkflowResourceAttributes {
  /** Who submitted the request. The maker. */
  initiatedById?: string | null;
  currentState?: string | null;
  instanceStatus?: WorkflowInstanceStatus | null;
  reworkCount?: number | null;

  /** Task holder, for the ownership policy. */
  assigneeUserId?: string | null;
  assigneeRole?: string | null;
  assigneeGroupId?: string | null;
  claimedById?: string | null;
  taskStatus?: string | null;

  /** Decisions for the current step and rework cycle only. */
  decisions?: WorkflowDecisionRecord[];
  /** Whether the step's definition permits self-approval. */
  allowSelfApproval?: boolean;

  /** Definition governance. */
  authoredById?: string | null;
  approvedById?: string | null;

  /** The actor's groups, resolved server-side. */
  actorGroupIds?: string[];

  /** Permission the definition attaches to the requested transition. */
  transitionPermission?: string | null;
}

/**
 * Builds the resource a workflow policy expects.
 *
 * One constructor rather than object literals at every call site, because a policy
 * that cannot find the field it needs *abstains* — and an abstaining separation-of-duty
 * policy is a control that silently does not run. A typo in `initiatedById` would turn
 * self-approval prevention off with no error anywhere.
 */
export function workflowResource(input: {
  type: (typeof WORKFLOW_RESOURCE_TYPES)[keyof typeof WORKFLOW_RESOURCE_TYPES];
  id: string;
  organizationId: string;
  attributes: WorkflowResourceAttributes;
}): {
  type: string;
  id: string;
  organizationId: string;
  ownerId: string | null;
  status: string | null;
  attributes: Record<string, unknown>;
} {
  return {
    type: input.type,
    id: input.id,
    organizationId: input.organizationId,
    // `ownerId` is the framework's generic "whose record is this", and for a workflow
    // instance that is the maker. Populating it means the framework's own
    // resource-ownership policy also sees it.
    ownerId: input.attributes.initiatedById ?? null,
    status: input.attributes.instanceStatus ?? input.attributes.taskStatus ?? null,
    attributes: { ...input.attributes } as Record<string, unknown>,
  };
}

function attributes(request: AuthorizationRequest): WorkflowResourceAttributes {
  return (request.resource?.attributes ?? {}) as WorkflowResourceAttributes;
}

function isWorkflowResource(request: AuthorizationRequest, type?: string): boolean {
  const resourceType = request.resource?.type;
  if (!resourceType) return false;
  if (type) return resourceType === type;
  return (Object.values(WORKFLOW_RESOURCE_TYPES) as string[]).includes(resourceType);
}

/**
 * Actions that count as an approval decision.
 *
 * An explicit set rather than a suffix match. `endsWith('.approve')` would also catch
 * `workflow.definition.approve`, which is definition governance and a different
 * control with a different rule — so the two are named separately.
 */
const APPROVAL_ACTIONS = new Set([
  'workflow.approval.decide',
  'workflow.instance.approve',
  'workflow.instance.reject',
  'workflow.instance.return_for_rework',
]);

function isApprovalAction(action: string): boolean {
  return APPROVAL_ACTIONS.has(action);
}

/** Lets a product register its own approval-shaped action. */
export function registerApprovalAction(action: string): void {
  APPROVAL_ACTIONS.add(action);
}

export function isRegisteredApprovalAction(action: string): boolean {
  return isApprovalAction(action);
}

// --- the policies ----------------------------------------------------------

/**
 * The maker cannot be the checker.
 *
 * The framework's central workflow control. `initiatedById` is read from the instance
 * row; a client-supplied value would make this bypassable in one line.
 */
export const selfApprovalPolicy: Policy = {
  id: 'workflow.self-approval',
  description: 'The actor who submitted a request cannot approve it.',

  appliesTo: (request) =>
    isWorkflowResource(request, WORKFLOW_RESOURCE_TYPES.INSTANCE) &&
    isApprovalAction(request.action) &&
    // The deliberate, audited exception. `validateDefinition` reports it as a warning
    // every time so it surfaces in review rather than passing unnoticed.
    attributes(request).allowSelfApproval !== true,

  evaluate: (request): PolicyResult | null => {
    const facts = attributes(request);
    if (!facts.initiatedById) return null;

    return isSameActor(request.actor?.userId, facts.initiatedById)
      ? { effect: 'deny', reason: 'self_approval_forbidden' }
      : null;
  },
};

/**
 * One decision per actor per step per rework cycle.
 *
 * Distinct from self-approval: this actor is a legitimate approver who has already
 * voted. It matters for threshold models, where counting one person's two clicks as
 * two approvals defeats "2 of 3" entirely.
 *
 * The decisions are scoped to the current step and cycle by the runtime — see the note
 * on `EvaluateApprovalInput` in `@trustos/workflow-approvals` for why the cycle
 * scoping is load-bearing.
 */
export const duplicateApprovalPolicy: Policy = {
  id: 'workflow.duplicate-approval',
  description: 'An actor may record at most one decision per approval step per rework cycle.',

  appliesTo: (request) =>
    isWorkflowResource(request, WORKFLOW_RESOURCE_TYPES.INSTANCE) &&
    isApprovalAction(request.action) &&
    Array.isArray(attributes(request).decisions),

  evaluate: (request): PolicyResult | null => {
    const actorId = request.actor?.userId;
    if (!actorId) return null;

    const decisions = attributes(request).decisions ?? [];
    return decisions.some((decision) => isSameActor(decision.actorId, actorId))
      ? { effect: 'deny', reason: 'duplicate_approval' }
      : null;
  },
};

/**
 * A workflow record belongs to one organization.
 *
 * `TenantGuard` checks that the actor belongs to the organization on the *request*.
 * This checks that the *record* belongs to the same one. Both are needed: the first
 * stops an actor claiming an organization they are not in, this stops an actor in A
 * reaching a record in B by id.
 */
export const workflowTenantPolicy: Policy = {
  id: 'workflow.tenant-isolation',
  description: 'A workflow record may only be reached from its owning organization.',

  appliesTo: (request) => isWorkflowResource(request) && Boolean(request.resource?.organizationId),

  evaluate: (request): PolicyResult | null => {
    const recordOrganization = request.resource?.organizationId;
    if (!recordOrganization) return null;

    const actorOrganization = request.organizationId ?? request.actor?.organizationId ?? null;

    // No scope at all is a deny, not an abstain. A workflow operation with no tenant
    // is a query with no WHERE clause.
    if (!actorOrganization) return { effect: 'deny', reason: 'cross_tenant_no_scope' };

    return recordOrganization === actorOrganization
      ? null
      : { effect: 'deny', reason: 'cross_tenant' };
  },
};

/**
 * Only the holder of a task may act on it.
 *
 * A pooled task is eligible to a population until somebody claims it; the claim then
 * narrows it to the claimant. Without this, two people work the same item and one
 * loses their work.
 *
 * Reads and reassignment are exempt. Reassignment is precisely the operation that
 * takes a task from its holder, and it has its own permission and audit record.
 */
export const taskOwnershipPolicy: Policy = {
  id: 'workflow.task-ownership',
  description: 'A task may only be acted on by its holder, or by an eligible member of its pool.',

  appliesTo: (request) =>
    isWorkflowResource(request, WORKFLOW_RESOURCE_TYPES.TASK) &&
    !request.action.endsWith('.read') &&
    !request.action.endsWith('.reassign'),

  evaluate: (request): PolicyResult | null => {
    const facts = attributes(request);
    const actorId = request.actor?.userId;
    if (!actorId) return null;

    if (facts.claimedById) {
      return isSameActor(facts.claimedById, actorId)
        ? null
        : { effect: 'deny', reason: 'task_claimed_by_another' };
    }

    if (facts.assigneeUserId) {
      return isSameActor(facts.assigneeUserId, actorId)
        ? null
        : { effect: 'deny', reason: 'task_assigned_to_another' };
    }

    if (facts.assigneeRole) {
      return (request.actor?.roles ?? []).includes(facts.assigneeRole)
        ? null
        : { effect: 'deny', reason: 'task_pool_role_not_held' };
    }

    if (facts.assigneeGroupId) {
      return (facts.actorGroupIds ?? []).includes(facts.assigneeGroupId)
        ? null
        : { effect: 'deny', reason: 'task_pool_group_not_member' };
    }

    /*
     * A task with no assignment is refused for everybody, including platform staff.
     *
     * It means the definition failed to assign the step. Treating it as open to all
     * would turn an authoring bug into a permanent hole that nobody notices, because
     * from the outside everything appears to work.
     */
    return { effect: 'deny', reason: 'task_has_no_assignment' };
  },
};

/**
 * A finished workflow takes no more actions.
 *
 * Stops a stale decision landing on a closed instance: an approver whose page was open
 * when somebody else rejected the request would otherwise approve something already
 * decided, and the trail would show an approval after a rejection.
 */
export const instanceActivePolicy: Policy = {
  id: 'workflow.instance-active',
  description: 'Only an active workflow instance accepts an action.',

  appliesTo: (request) =>
    isWorkflowResource(request, WORKFLOW_RESOURCE_TYPES.INSTANCE) &&
    // Reads stay available on a closed instance. That is what history is for.
    !request.action.endsWith('.read') &&
    Boolean(attributes(request).instanceStatus),

  evaluate: (request): PolicyResult | null => {
    const status = attributes(request).instanceStatus;
    return status === 'active' ? null : { effect: 'deny', reason: `instance_${status}` };
  },
};

/**
 * The author of a workflow version cannot approve or publish it.
 *
 * Maker-checker applied to the definitions themselves, and the control that stops the
 * whole system being circumvented: somebody who can author *and* publish can publish a
 * definition with `allowSelfApproval: true` and then approve their own requests
 * through it. Every other policy in this file assumes the definition was reviewed by
 * somebody other than its author.
 */
export const definitionGovernancePolicy: Policy = {
  id: 'workflow.definition-governance',
  description: 'A workflow version must be authored, approved and published by different people.',

  appliesTo: (request) =>
    isWorkflowResource(request, WORKFLOW_RESOURCE_TYPES.VERSION) &&
    (request.action === 'workflow.definition.approve' ||
      request.action === 'workflow.definition.publish'),

  evaluate: (request): PolicyResult | null => {
    const facts = attributes(request);
    const actorId = request.actor?.userId;
    if (!actorId) return null;

    if (isSameActor(facts.authoredById, actorId)) {
      return { effect: 'deny', reason: 'author_cannot_approve_or_publish' };
    }

    /*
     * The approver may not also publish.
     *
     * Three people rather than two, and worth the extra step: approval is a judgement
     * that the definition is correct, publication is the act of making it live. One
     * person doing both means one person's opinion is the only thing between a draft
     * and production.
     */
    if (
      request.action === 'workflow.definition.publish' &&
      isSameActor(facts.approvedById, actorId)
    ) {
      return { effect: 'deny', reason: 'approver_cannot_publish' };
    }

    return null;
  },
};

/**
 * The rework cycle limit.
 *
 * An unbounded return-for-rework loop is how a request stays open for a year while both
 * sides believe the other has it. The limit is in the definition; this enforces it as a
 * policy so it applies wherever a rework transition is declared.
 */
export function reworkLimitPolicy(maxCycles: number | null): Policy {
  return {
    id: 'workflow.rework-limit',
    description: `A request may be returned for rework at most ${maxCycles ?? 'unlimited'} times.`,

    appliesTo: (request) =>
      maxCycles !== null &&
      isWorkflowResource(request, WORKFLOW_RESOURCE_TYPES.INSTANCE) &&
      request.action === 'workflow.instance.return_for_rework',

    evaluate: (request): PolicyResult | null => {
      if (maxCycles === null) return null;
      const count = attributes(request).reworkCount ?? 0;
      return count >= maxCycles ? { effect: 'deny', reason: 'rework_limit_reached' } : null;
    },
  };
}

/**
 * The permission the *definition* attaches to a transition.
 *
 * Complements `PermissionsGuard`, which checks the *route's* permission. An
 * administrator holding `workflow.instance.transition` still cannot take a transition
 * the definition reserves for `workflow.approval.decide` — so a definition can be
 * stricter than the route it is reached through, and never looser.
 */
export const transitionPermissionPolicy: Policy = {
  id: 'workflow.transition-permission',
  description: 'A transition requires the permission its definition declares.',

  appliesTo: (request) =>
    isWorkflowResource(request, WORKFLOW_RESOURCE_TYPES.INSTANCE) &&
    Boolean(attributes(request).transitionPermission),

  evaluate: (request): PolicyResult | null => {
    const required = attributes(request).transitionPermission;
    if (!required) return null;

    // The framework's own checker, so the wildcard grant and super-admin are treated
    // exactly as they are everywhere else rather than re-implemented here.
    return hasPermission(request.actor, required)
      ? null
      : { effect: 'deny', reason: 'transition_permission_missing' };
  },
};

/**
 * The framework's workflow policy set, in order.
 *
 * The order does not change the outcome — any deny refuses — but it does change which
 * reason is reported, and the reason is what somebody acts on:
 *
 *   1. tenant isolation, so a cross-tenant reach is never told anything more specific
 *   2. instance active, because a closed workflow makes every later question moot
 *   3. self-approval, *before* permissions: telling a maker "you lack the approval
 *      permission" sends them to an administrator for a grant that will not help
 *   4. duplicate approval
 *   5. task ownership
 *   6. definition governance
 *   7. the definition's own transition permission
 */
export const WORKFLOW_POLICIES: Policy[] = [
  workflowTenantPolicy,
  instanceActivePolicy,
  selfApprovalPolicy,
  duplicateApprovalPolicy,
  taskOwnershipPolicy,
  definitionGovernancePolicy,
  transitionPermissionPolicy,
];

/**
 * Reasons these policies produce.
 *
 * Exported so a caller can map a reason to a message without matching on strings
 * scattered through the file, and so a test asserts on a constant rather than on
 * wording that may be reworded.
 */
export const WORKFLOW_DENY_REASONS = [
  'self_approval_forbidden',
  'duplicate_approval',
  'cross_tenant',
  'cross_tenant_no_scope',
  'task_claimed_by_another',
  'task_assigned_to_another',
  'task_pool_role_not_held',
  'task_pool_group_not_member',
  'task_has_no_assignment',
  'instance_completed',
  'instance_cancelled',
  'instance_rejected',
  'author_cannot_approve_or_publish',
  'approver_cannot_publish',
  'rework_limit_reached',
  'transition_permission_missing',
] as const;

export type WorkflowDenyReason = (typeof WORKFLOW_DENY_REASONS)[number];

/**
 * A message safe to show a caller.
 *
 * The cross-tenant reasons deliberately map to a vague message: the runtime turns them
 * into a 404 anyway, and confirming the record exists elsewhere is the enumeration
 * primitive the boundary exists to deny.
 */
export function explainDenial(reason: string): string {
  const messages: Record<string, string> = {
    self_approval_forbidden: 'You submitted this request, so you cannot approve it.',
    duplicate_approval: 'You have already recorded a decision on this step.',
    cross_tenant: 'Not found.',
    cross_tenant_no_scope: 'Not found.',
    task_claimed_by_another: 'Somebody else holds this task.',
    task_assigned_to_another: 'This task is assigned to somebody else.',
    task_pool_role_not_held: 'This task is pooled to a role you do not hold.',
    task_pool_group_not_member: 'This task is pooled to a group you are not in.',
    task_has_no_assignment:
      'This task has no assignment, so nobody is eligible for it. The workflow definition ' +
      'needs fixing.',
    instance_completed: 'This workflow is complete and takes no further action.',
    instance_cancelled: 'This workflow was cancelled and takes no further action.',
    instance_rejected: 'This workflow was rejected and takes no further action.',
    author_cannot_approve_or_publish:
      'You authored this workflow version, so somebody else must approve and publish it.',
    approver_cannot_publish:
      'You approved this version, so a third person must publish it. Approval and publication ' +
      'are deliberately separate acts.',
    rework_limit_reached:
      'This request has reached its rework limit. Approve it, reject it, or escalate.',
    transition_permission_missing: 'You do not hold the permission this transition requires.',
  };

  return messages[reason] ?? 'This action is not permitted.';
}
