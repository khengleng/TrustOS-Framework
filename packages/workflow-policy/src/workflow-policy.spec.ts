import { describe, expect, it } from 'vitest';
import { authorize, type AuthorizationRequest } from '@trustsystem/authorization';
import type { ActorContext } from '@trustsystem/shared-types';
import type { WorkflowDecisionRecord } from '@trustsystem/workflow-core';
import {
  explainDenial,
  isRegisteredApprovalAction,
  registerApprovalAction,
  reworkLimitPolicy,
  WORKFLOW_POLICIES,
  WORKFLOW_RESOURCE_TYPES,
  workflowResource,
  type WorkflowResourceAttributes,
} from './policies';

/**
 * Policy tests.
 *
 * These run the policies through the real `authorize()` engine rather than calling
 * `evaluate` directly, so they exercise the properties the engine provides: default deny,
 * explicit deny wins, and `appliesTo` gating. A policy that abstained when it should have
 * denied would pass a direct-call test and fail here.
 *
 * The set contains no policy that *allows*, so every request in this file is denied unless
 * a permitting policy is added — which is what the `allowAll` helper does.
 */

const ACME = 'org_acme';
const OTHER = 'org_globex';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorType: 'user',
    userId: 'user_checker',
    email: 'checker@acme.test',
    organizationId: ACME,
    roles: ['workflow_checker'],
    permissions: ['workflow.approval.decide', 'workflow.instance.transition'],
    isSuperAdmin: false,
    tokenId: 'tok',
    ...overrides,
  };
}

/** A permitting policy, so a request that no workflow policy denies can be observed. */
const allowAll = {
  id: 'test.allow',
  description: 'Allows anything nothing else denied. Test only.',
  appliesTo: () => true,
  evaluate: () => ({ effect: 'allow' as const, reason: 'test_allow' }),
};

function decide(
  request: AuthorizationRequest,
  extra: Parameters<typeof authorize>[1]['policies'] = [],
) {
  return authorize(request, { policies: [...WORKFLOW_POLICIES, ...extra, allowAll] });
}

function instanceRequest(
  action: string,
  attributes: WorkflowResourceAttributes,
  overrides: Partial<AuthorizationRequest> = {},
): AuthorizationRequest {
  return {
    actor: actor(),
    action,
    organizationId: ACME,
    resource: workflowResource({
      type: WORKFLOW_RESOURCE_TYPES.INSTANCE,
      id: 'wfi_1',
      organizationId: ACME,
      attributes: { instanceStatus: 'active', ...attributes },
    }),
    ...overrides,
  };
}

function decision(actorId: string): WorkflowDecisionRecord {
  return {
    id: `d_${actorId}`,
    organizationId: ACME,
    workflowInstanceId: 'wfi_1',
    workflowTaskId: null,
    stepKey: 'review',
    approverKey: 'a1',
    actorId,
    actorType: 'user',
    actorRole: 'workflow_checker',
    decision: 'approve',
    reasonCode: null,
    explanation: null,
    policyDecisionId: 'dec',
    reworkCycle: 0,
    decidedAt: new Date(),
  };
}

// ===========================================================================
// Self-approval
// ===========================================================================

describe('self-approval', () => {
  it('denies the submitter approving their own request', () => {
    const outcome = decide(
      instanceRequest('workflow.approval.decide', { initiatedById: 'user_checker' }),
    );

    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toBe('self_approval_forbidden');
  });

  it('allows a different actor to approve', () => {
    expect(
      decide(instanceRequest('workflow.approval.decide', { initiatedById: 'user_maker' })).allow,
    ).toBe(true);
  });

  it('does not apply to a non-approval action', () => {
    // A maker legitimately edits, comments on and cancels their own request. What they
    // cannot do is approve it.
    expect(
      decide(instanceRequest('workflow.instance.transition', { initiatedById: 'user_checker' }))
        .allow,
    ).toBe(true);
  });

  it('yields to an explicit definition-level exception', () => {
    expect(
      decide(
        instanceRequest('workflow.approval.decide', {
          initiatedById: 'user_checker',
          allowSelfApproval: true,
        }),
      ).allow,
    ).toBe(true);
  });

  it('does not treat two absent ids as a match', () => {
    // A system-initiated workflow has no initiator, and treating "nobody" as matching
    // "nobody" would disable the check on exactly the instances where the bug would be
    // hardest to see.
    expect(decide(instanceRequest('workflow.approval.decide', { initiatedById: null })).allow).toBe(
      true,
    );
  });

  it('abstains rather than denying when the initiator is not supplied', () => {
    // A policy that cannot find its field abstains, which is why `workflowResource` exists
    // — a typo would turn this control off with no error anywhere.
    const outcome = decide(instanceRequest('workflow.approval.decide', {}));
    expect(outcome.allow).toBe(true);
  });
});

// ===========================================================================
// Duplicate approval
// ===========================================================================

describe('duplicate approval', () => {
  it('denies an actor who already decided on this step and cycle', () => {
    const outcome = decide(
      instanceRequest('workflow.approval.decide', {
        initiatedById: 'user_maker',
        decisions: [decision('user_checker')],
      }),
    );

    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toBe('duplicate_approval');
  });

  it('allows an actor who has not decided', () => {
    expect(
      decide(
        instanceRequest('workflow.approval.decide', {
          initiatedById: 'user_maker',
          decisions: [decision('user_someone_else')],
        }),
      ).allow,
    ).toBe(true);
  });
});

// ===========================================================================
// Tenant isolation
// ===========================================================================

describe('tenant isolation', () => {
  it('denies a record belonging to another organization', () => {
    const outcome = decide({
      actor: actor(),
      action: 'workflow.instance.read',
      organizationId: ACME,
      resource: workflowResource({
        type: WORKFLOW_RESOURCE_TYPES.INSTANCE,
        id: 'wfi_1',
        organizationId: OTHER,
        attributes: { instanceStatus: 'active' },
      }),
    });

    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toBe('cross_tenant');
  });

  it('denies a request with no organization scope at all', () => {
    // A workflow operation with no tenant is a query with no WHERE clause.
    const outcome = decide({
      actor: actor({ organizationId: null }),
      action: 'workflow.instance.read',
      organizationId: null,
      resource: workflowResource({
        type: WORKFLOW_RESOURCE_TYPES.INSTANCE,
        id: 'wfi_1',
        organizationId: ACME,
        attributes: {},
      }),
    });

    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toBe('cross_tenant_no_scope');
  });

  it('reports the cross-tenant reason before anything more specific', () => {
    // A cross-tenant reach must never be told anything more specific than "no". This
    // request would also fail the self-approval check; tenancy wins because it is first.
    const outcome = decide({
      actor: actor(),
      action: 'workflow.approval.decide',
      organizationId: ACME,
      resource: workflowResource({
        type: WORKFLOW_RESOURCE_TYPES.INSTANCE,
        id: 'wfi_1',
        organizationId: OTHER,
        attributes: { instanceStatus: 'active', initiatedById: 'user_checker' },
      }),
    });

    expect(outcome.reason).toBe('cross_tenant');
  });

  it('maps a cross-tenant reason to a message that confirms nothing', () => {
    // Confirming the record exists elsewhere is the enumeration primitive the boundary
    // exists to deny.
    expect(explainDenial('cross_tenant')).toBe('Not found.');
    expect(explainDenial('cross_tenant_no_scope')).toBe('Not found.');
  });
});

// ===========================================================================
// Instance status
// ===========================================================================

describe('instance status', () => {
  it('denies an action on a completed instance', () => {
    const outcome = decide(
      instanceRequest('workflow.approval.decide', {
        initiatedById: 'user_maker',
        instanceStatus: 'completed',
      }),
    );

    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toBe('instance_completed');
  });

  it('denies an action on a cancelled or rejected instance', () => {
    for (const status of ['cancelled', 'rejected'] as const) {
      expect(
        decide(
          instanceRequest('workflow.instance.transition', {
            initiatedById: 'user_maker',
            instanceStatus: status,
          }),
        ).reason,
      ).toBe(`instance_${status}`);
    }
  });

  it('still allows reads on a closed instance', () => {
    // That is what history is for.
    expect(
      decide(
        instanceRequest('workflow.instance.read', {
          initiatedById: 'user_maker',
          instanceStatus: 'completed',
        }),
      ).allow,
    ).toBe(true);
  });
});

// ===========================================================================
// Task ownership
// ===========================================================================

describe('task ownership', () => {
  function taskRequest(
    action: string,
    attributes: WorkflowResourceAttributes,
    who: Partial<ActorContext> = {},
  ): AuthorizationRequest {
    return {
      actor: actor(who),
      action,
      organizationId: ACME,
      resource: workflowResource({
        type: WORKFLOW_RESOURCE_TYPES.TASK,
        id: 'wft_1',
        organizationId: ACME,
        attributes,
      }),
    };
  }

  it('denies somebody who is not the claimant', () => {
    expect(
      decide(taskRequest('workflow.task.complete', { claimedById: 'user_other' })).reason,
    ).toBe('task_claimed_by_another');
  });

  it('allows the claimant', () => {
    expect(
      decide(taskRequest('workflow.task.complete', { claimedById: 'user_checker' })).allow,
    ).toBe(true);
  });

  it('allows an eligible member of a pooled role', () => {
    expect(
      decide(taskRequest('workflow.task.complete', { assigneeRole: 'workflow_checker' })).allow,
    ).toBe(true);
  });

  it('denies somebody outside a pooled group', () => {
    expect(
      decide(
        taskRequest('workflow.task.complete', {
          assigneeGroupId: 'reviewers',
          actorGroupIds: [],
        }),
      ).reason,
    ).toBe('task_pool_group_not_member');
  });

  it('denies everybody on a task with no assignment', () => {
    // Including platform staff. A task nobody was assigned means the definition failed to
    // assign the step, and treating it as open to all would turn an authoring bug into a
    // permanent hole.
    expect(decide(taskRequest('workflow.task.complete', {}, { isSuperAdmin: true })).reason).toBe(
      'task_has_no_assignment',
    );
  });

  it('exempts reads and reassignment', () => {
    // Reassignment is precisely the operation that takes a task from its holder.
    expect(decide(taskRequest('workflow.task.reassign', { claimedById: 'user_other' })).allow).toBe(
      true,
    );
    expect(decide(taskRequest('workflow.task.read', { claimedById: 'user_other' })).allow).toBe(
      true,
    );
  });
});

// ===========================================================================
// Definition governance
// ===========================================================================

describe('definition governance', () => {
  function versionRequest(
    action: string,
    attributes: WorkflowResourceAttributes,
    who: Partial<ActorContext> = {},
  ): AuthorizationRequest {
    return {
      actor: actor(who),
      action,
      organizationId: ACME,
      resource: workflowResource({
        type: WORKFLOW_RESOURCE_TYPES.VERSION,
        id: 'wv_1',
        organizationId: ACME,
        attributes,
      }),
    };
  }

  it('denies the author approving their own version', () => {
    // The control that stops the whole engine being circumvented: an author who could also
    // publish could ship `allowSelfApproval: true` and approve their own requests.
    expect(
      decide(
        versionRequest(
          'workflow.definition.approve',
          { authoredById: 'user_checker' },
          { userId: 'user_checker' },
        ),
      ).reason,
    ).toBe('author_cannot_approve_or_publish');
  });

  it('denies the author publishing their own version', () => {
    expect(
      decide(
        versionRequest(
          'workflow.definition.publish',
          { authoredById: 'user_checker' },
          { userId: 'user_checker' },
        ),
      ).reason,
    ).toBe('author_cannot_approve_or_publish');
  });

  it('denies the approver publishing what they approved', () => {
    // Three people rather than two: approval is a judgement that the definition is
    // correct, publication is the act of making it live.
    expect(
      decide(
        versionRequest(
          'workflow.definition.publish',
          { authoredById: 'user_author', approvedById: 'user_checker' },
          { userId: 'user_checker' },
        ),
      ).reason,
    ).toBe('approver_cannot_publish');
  });

  it('allows a third person to publish', () => {
    expect(
      decide(
        versionRequest(
          'workflow.definition.publish',
          { authoredById: 'user_author', approvedById: 'user_approver' },
          { userId: 'user_publisher' },
        ),
      ).allow,
    ).toBe(true);
  });

  it('does not apply to reading a version', () => {
    expect(
      decide(
        versionRequest(
          'workflow.definition.read',
          { authoredById: 'user_checker' },
          { userId: 'user_checker' },
        ),
      ).allow,
    ).toBe(true);
  });
});

// ===========================================================================
// Rework limit and transition permission
// ===========================================================================

describe('the rework limit', () => {
  it('denies a return beyond the limit', () => {
    const outcome = authorize(
      instanceRequest('workflow.instance.return_for_rework', {
        initiatedById: 'user_maker',
        reworkCount: 3,
      }),
      { policies: [...WORKFLOW_POLICIES, reworkLimitPolicy(3), allowAll] },
    );

    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toBe('rework_limit_reached');
  });

  it('allows a return below the limit', () => {
    expect(
      authorize(
        instanceRequest('workflow.instance.return_for_rework', {
          initiatedById: 'user_maker',
          reworkCount: 1,
        }),
        { policies: [...WORKFLOW_POLICIES, reworkLimitPolicy(3), allowAll] },
      ).allow,
    ).toBe(true);
  });

  it('does not apply when the limit is null', () => {
    expect(
      authorize(
        instanceRequest('workflow.instance.return_for_rework', {
          initiatedById: 'user_maker',
          reworkCount: 99,
        }),
        { policies: [...WORKFLOW_POLICIES, reworkLimitPolicy(null), allowAll] },
      ).allow,
    ).toBe(true);
  });
});

describe('the definition’s own transition permission', () => {
  it('denies an actor who does not hold it, even with a route-level grant', () => {
    // A definition can be stricter than the route it is reached through, and never looser.
    const outcome = decide(
      instanceRequest('workflow.instance.transition', {
        initiatedById: 'user_maker',
        transitionPermission: 'finance.release',
      }),
    );

    expect(outcome.allow).toBe(false);
    expect(outcome.reason).toBe('transition_permission_missing');
  });

  it('allows an actor who holds it', () => {
    expect(
      decide(
        instanceRequest('workflow.instance.transition', {
          initiatedById: 'user_maker',
          transitionPermission: 'workflow.instance.transition',
        }),
      ).allow,
    ).toBe(true);
  });

  it('treats the wildcard and super-admin the framework’s way', () => {
    // The framework's own checker rather than a re-implementation, so the wildcard behaves
    // here exactly as it does everywhere else.
    expect(
      decide(
        instanceRequest(
          'workflow.instance.transition',
          { initiatedById: 'user_maker', transitionPermission: 'finance.release' },
          { actor: actor({ isSuperAdmin: true }) },
        ),
      ).allow,
    ).toBe(true);
  });
});

// ===========================================================================
// The set as a whole
// ===========================================================================

describe('the policy set', () => {
  it('contains no policy that allows', () => {
    // The property that makes the set safe to extend: adding a policy can only make the
    // system stricter.
    const alwaysApplicable: AuthorizationRequest = instanceRequest('anything', {
      initiatedById: 'user_maker',
    });

    for (const policy of WORKFLOW_POLICIES) {
      if (!policy.appliesTo(alwaysApplicable)) continue;
      const result = policy.evaluate(alwaysApplicable);
      expect(result?.effect, policy.id).not.toBe('allow');
    }
  });

  it('denies by default when nothing permits', () => {
    // Without `allowAll` the request is refused, which is the engine's default-deny.
    const outcome = authorize(
      instanceRequest('workflow.approval.decide', { initiatedById: 'user_maker' }),
      {
        policies: WORKFLOW_POLICIES,
      },
    );

    expect(outcome.allow).toBe(false);
  });

  it('gives every decision an id', () => {
    // The id is what connects a 403 to the security event that explains it.
    const outcome = decide(
      instanceRequest('workflow.approval.decide', { initiatedById: 'user_maker' }),
    );
    expect(outcome.decisionId).toMatch(/.+/);
  });

  it('ignores a resource that is not a workflow resource', () => {
    const outcome = decide({
      actor: actor(),
      action: 'merchant.update',
      organizationId: ACME,
      resource: { type: 'Merchant', id: 'm_1', organizationId: ACME },
    });

    expect(outcome.allow).toBe(true);
  });

  it('lets a product register its own approval-shaped action', () => {
    expect(isRegisteredApprovalAction('payment.release')).toBe(false);
    registerApprovalAction('payment.release');
    expect(isRegisteredApprovalAction('payment.release')).toBe(true);

    // And the self-approval policy now covers it.
    expect(
      decide(instanceRequest('payment.release', { initiatedById: 'user_checker' })).reason,
    ).toBe('self_approval_forbidden');
  });
});

describe('explaining a denial', () => {
  it('has a message for every reason the policies produce', () => {
    for (const reason of [
      'self_approval_forbidden',
      'duplicate_approval',
      'task_claimed_by_another',
      'task_has_no_assignment',
      'instance_completed',
      'author_cannot_approve_or_publish',
      'approver_cannot_publish',
      'rework_limit_reached',
      'transition_permission_missing',
    ]) {
      expect(explainDenial(reason), reason).not.toBe('This action is not permitted.');
    }
  });

  it('falls back to something safe for an unknown reason', () => {
    expect(explainDenial('something_new')).toBe('This action is not permitted.');
  });
});
