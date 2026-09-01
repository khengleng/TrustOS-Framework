import { describe, expect, it } from 'vitest';
import type { WorkflowActor, WorkflowDecisionRecord } from '@trustsystem/workflow-core';
import type { WorkflowApprovalSpec } from '@trustsystem/workflow-definition';
import {
  checkApproverEligibility,
  decisionRequiresReason,
  describeNextApproval,
  evaluateApproval,
  requiredApprovalCount,
  resolveRequiredApprovers,
} from './models';

/**
 * Approval-model tests.
 *
 * Everything here is a pure function of a decision trail, which is what makes the tests
 * short: build a list of decisions, ask what the model thinks. There is no store, no
 * clock and no fixture to reset.
 */

const ACME = 'org_acme';

function actor(userId: string, overrides: Partial<WorkflowActor> = {}): WorkflowActor {
  return {
    userId,
    actorType: 'user',
    email: `${userId}@acme.test`,
    tokenId: 'tok',
    organizationId: ACME,
    roles: ['workflow_checker'],
    permissions: ['workflow.approval.decide'],
    isSuperAdmin: false,
    groupIds: [],
    authenticationLevel: 'medium',
    mfa: false,
    ...overrides,
  };
}

function decision(
  actorId: string,
  outcome: WorkflowDecisionRecord['decision'],
  approverKey: string | null = null,
): WorkflowDecisionRecord {
  return {
    id: `d_${actorId}_${outcome}`,
    organizationId: ACME,
    workflowInstanceId: 'wfi_1',
    workflowTaskId: null,
    stepKey: 'review',
    approverKey,
    actorId,
    actorType: 'user',
    actorRole: 'workflow_checker',
    decision: outcome,
    reasonCode: outcome === 'approve' ? null : 'because',
    explanation: null,
    policyDecisionId: 'dec_1',
    reworkCycle: 0,
    decidedAt: new Date(),
  };
}

function approvers(count: number, withOrder = false): WorkflowApprovalSpec['approvers'] {
  return Array.from({ length: count }, (_, index) => ({
    key: `a${index + 1}`,
    name: `Approver ${index + 1}`,
    permission: 'workflow.approval.decide',
    slaMinutes: null,
    ...(withOrder ? { order: index + 1 } : {}),
  }));
}

function spec(overrides: Partial<WorkflowApprovalSpec>): WorkflowApprovalSpec {
  return {
    model: 'single',
    approvers: approvers(1),
    allowSelfApproval: false,
    allowSameActorMultipleSlots: false,
    rejectionReasonCodes: [],
    ...overrides,
  } as WorkflowApprovalSpec;
}

// ===========================================================================
// The six models
// ===========================================================================

describe('single approval', () => {
  it('is satisfied by one decision', () => {
    const approval = spec({ model: 'single' });

    expect(evaluateApproval({ approval, decisions: [], data: {} })).toMatchObject({
      satisfied: false,
      required: 1,
      approvals: 0,
    });

    expect(
      evaluateApproval({ approval, decisions: [decision('u1', 'approve', 'a1')], data: {} }),
    ).toMatchObject({ satisfied: true, approvals: 1 });
  });
});

describe('parallel approval', () => {
  it('is settled by the first decision from any eligible approver', () => {
    const approval = spec({ model: 'parallel', approvers: approvers(3) });

    // Several may review at once; one decision settles it. That is what distinguishes
    // parallel from unanimous.
    expect(requiredApprovalCount(approval, approval.approvers)).toBe(1);
    expect(
      evaluateApproval({ approval, decisions: [decision('u2', 'approve', 'a2')], data: {} })
        .satisfied,
    ).toBe(true);
  });
});

describe('unanimous approval', () => {
  it('needs every listed approver', () => {
    const approval = spec({ model: 'unanimous', approvers: approvers(3) });

    expect(requiredApprovalCount(approval, approval.approvers)).toBe(3);

    const two = evaluateApproval({
      approval,
      decisions: [decision('u1', 'approve', 'a1'), decision('u2', 'approve', 'a2')],
      data: {},
    });
    expect(two).toMatchObject({ satisfied: false, approvals: 2, required: 3 });
    // Only the unfilled slot is outstanding, which is what `approverKey` on a decision is
    // for — without it there is no way to tell a filled slot from an unfilled one when
    // two approvers share a permission.
    expect(two.outstanding.map((entry) => entry.key)).toEqual(['a3']);

    expect(
      evaluateApproval({
        approval,
        decisions: [
          decision('u1', 'approve', 'a1'),
          decision('u2', 'approve', 'a2'),
          decision('u3', 'approve', 'a3'),
        ],
        data: {},
      }).satisfied,
    ).toBe(true);
  });
});

describe('threshold approval', () => {
  it('needs K distinct actors out of N', () => {
    const approval = spec({ model: 'threshold', threshold: 2, approvers: approvers(3) });

    expect(
      evaluateApproval({ approval, decisions: [decision('u1', 'approve', 'a1')], data: {} }),
    ).toMatchObject({ satisfied: false, approvals: 1, required: 2 });

    expect(
      evaluateApproval({
        approval,
        decisions: [decision('u1', 'approve', 'a1'), decision('u2', 'approve', 'a2')],
        data: {},
      }).satisfied,
    ).toBe(true);
  });

  it('counts one actor once, however many times they approve', () => {
    const approval = spec({ model: 'threshold', threshold: 2, approvers: approvers(3) });

    // A threshold that one person can meet is not a threshold.
    const twice = [
      { ...decision('u1', 'approve', 'a1'), id: 'd1' },
      { ...decision('u1', 'approve', 'a2'), id: 'd2' },
    ];

    expect(evaluateApproval({ approval, decisions: twice, data: {} })).toMatchObject({
      approvals: 1,
      satisfied: false,
    });
  });

  it('counts each decision when the definition explicitly allows it', () => {
    const approval = spec({
      model: 'threshold',
      threshold: 2,
      approvers: approvers(3),
      allowSameActorMultipleSlots: true,
    });

    const twice = [
      { ...decision('u1', 'approve', 'a1'), id: 'd1' },
      { ...decision('u1', 'approve', 'a2'), id: 'd2' },
    ];

    // The definition asked for this, and `validateDefinition` warns about it every time.
    expect(evaluateApproval({ approval, decisions: twice, data: {} }).satisfied).toBe(true);
  });
});

describe('sequential approval', () => {
  it('offers exactly one approver at a time, in order', () => {
    const approval = spec({ model: 'sequential', approvers: approvers(3, true) });

    const none = evaluateApproval({ approval, decisions: [], data: {} });
    // Offering the third approver a button before the first has acted would teach people
    // that the system rejects valid actions.
    expect(none.outstanding.map((entry) => entry.key)).toEqual(['a1']);

    const one = evaluateApproval({
      approval,
      decisions: [decision('u1', 'approve', 'a1')],
      data: {},
    });
    expect(one.outstanding.map((entry) => entry.key)).toEqual(['a2']);
    expect(one.satisfied).toBe(false);

    const all = evaluateApproval({
      approval,
      decisions: [
        decision('u1', 'approve', 'a1'),
        decision('u2', 'approve', 'a2'),
        decision('u3', 'approve', 'a3'),
      ],
      data: {},
    });
    expect(all.satisfied).toBe(true);
    expect(all.outstanding).toEqual([]);
  });

  it('refuses somebody whose turn has not come', () => {
    const approval = spec({
      model: 'sequential',
      approvers: [
        { key: 'ops', name: 'Ops', permission: 'ops.approve', order: 1, slaMinutes: null },
        {
          key: 'finance',
          name: 'Finance',
          permission: 'finance.approve',
          order: 2,
          slaMinutes: null,
        },
      ],
    });

    // Finance holds only `finance.approve`, and the step is awaiting Ops.
    const verdict = checkApproverEligibility({
      approval,
      actor: actor('u_finance', { permissions: ['finance.approve'] }),
      initiatedById: 'u_maker',
      decisions: [],
      data: {},
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('not_next_in_sequence');
    expect(verdict.detail).toContain('Ops');
  });
});

describe('conditional approval', () => {
  it('skips an approver whose condition does not hold, and records that it did', () => {
    const approval = spec({
      model: 'conditional',
      approvers: [
        {
          key: 'manager',
          name: 'Manager',
          permission: 'workflow.approval.decide',
          slaMinutes: null,
        },
        {
          key: 'compliance',
          name: 'Compliance',
          permission: 'workflow.approval.decide',
          condition: { field: 'riskRating', operator: 'eq', value: 'high' },
          slaMinutes: null,
        },
      ],
    });

    const low = resolveRequiredApprovers(approval, { riskRating: 'low' });
    expect(low.required.map((entry) => entry.key)).toEqual(['manager']);
    // An auditor asking "why did compliance not review this?" needs the answer
    // "because riskRating was medium", not an absence.
    expect(low.skipped).toEqual([
      { key: 'compliance', name: 'Compliance', reason: 'condition_not_met' },
    ]);

    const high = resolveRequiredApprovers(approval, { riskRating: 'high' });
    expect(high.required.map((entry) => entry.key)).toEqual(['manager', 'compliance']);
    expect(high.skipped).toEqual([]);
  });

  it('reports the skipped approvers in the evaluation', () => {
    const approval = spec({
      model: 'conditional',
      approvers: [
        {
          key: 'manager',
          name: 'Manager',
          permission: 'workflow.approval.decide',
          slaMinutes: null,
        },
        {
          key: 'compliance',
          name: 'Compliance',
          permission: 'workflow.approval.decide',
          condition: { field: 'riskRating', operator: 'eq', value: 'high' },
          slaMinutes: null,
        },
      ],
    });

    const progress = evaluateApproval({ approval, decisions: [], data: { riskRating: 'low' } });
    expect(progress.skipped.map((entry) => entry.key)).toEqual(['compliance']);
  });

  it('refuses everybody when every approver was skipped', () => {
    const approval = spec({
      model: 'conditional',
      approvers: [
        {
          key: 'compliance',
          name: 'Compliance',
          permission: 'workflow.approval.decide',
          condition: { field: 'riskRating', operator: 'eq', value: 'high' },
          slaMinutes: null,
        },
      ],
    });

    // `validateDefinition` refuses a definition shaped this way, so this is the runtime's
    // second line: nobody is eligible rather than the step passing with no review.
    const verdict = checkApproverEligibility({
      approval,
      actor: actor('u1'),
      initiatedById: 'u_maker',
      decisions: [],
      data: { riskRating: 'low' },
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('no_slot_available');
  });
});

// ===========================================================================
// Rejection and return
// ===========================================================================

describe('rejection and return', () => {
  it('settles a step immediately, whatever the model requires', () => {
    for (const model of ['unanimous', 'threshold', 'sequential'] as const) {
      const approval = spec({
        model,
        approvers: approvers(3, model === 'sequential'),
        ...(model === 'threshold' ? { threshold: 3 } : {}),
      });

      // "Three must approve but one may veto" is how every real approval chain works.
      const rejected = evaluateApproval({
        approval,
        decisions: [decision('u1', 'reject')],
        data: {},
      });
      expect(rejected.rejected, model).toBe(true);
      expect(rejected.satisfied, model).toBe(false);
      expect(rejected.outstanding, model).toEqual([]);
    }
  });

  it('reports a return separately from a rejection', () => {
    const approval = spec({ model: 'single' });

    const returned = evaluateApproval({
      approval,
      decisions: [decision('u1', 'return_for_rework')],
      data: {},
    });

    // Different outcomes: a rejection ends the request, a return sends it back.
    expect(returned).toMatchObject({ returned: true, rejected: false, satisfied: false });
    expect(returned.summary).toContain('Returned for rework');
  });

  it('requires a reason for anything other than an approval', () => {
    expect(decisionRequiresReason('approve')).toBe(false);
    // A rejection with no reason is unusable by the maker and worthless to an auditor.
    expect(decisionRequiresReason('reject')).toBe(true);
    expect(decisionRequiresReason('return_for_rework')).toBe(true);
    expect(decisionRequiresReason('abstain')).toBe(true);
  });
});

// ===========================================================================
// Eligibility
// ===========================================================================

describe('eligibility', () => {
  it('refuses the submitter, before checking permissions', () => {
    const approval = spec({ model: 'single' });

    // The maker holds the approval permission here, so the refusal cannot be a missing
    // grant. Reporting "you lack the permission" would send them to an administrator for
    // something that will not help.
    const verdict = checkApproverEligibility({
      approval,
      actor: actor('u_maker'),
      initiatedById: 'u_maker',
      decisions: [],
      data: {},
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('self_approval_forbidden');
  });

  it('permits the submitter when the definition explicitly allows it', () => {
    const approval = spec({ model: 'single', allowSelfApproval: true });

    // A deliberate, audited exception. `validateDefinition` warns about it every time so
    // it appears in review.
    expect(
      checkApproverEligibility({
        approval,
        actor: actor('u_maker'),
        initiatedById: 'u_maker',
        decisions: [],
        data: {},
      }).eligible,
    ).toBe(true);
  });

  it('never treats two absent actors as the same actor', () => {
    const approval = spec({ model: 'single' });

    // A system-initiated workflow has no initiator. Treating "nobody" as matching
    // "nobody" would silently disable the self-approval check on exactly the instances
    // where the bug would be hardest to see.
    expect(
      checkApproverEligibility({
        approval,
        actor: actor('u1'),
        initiatedById: '',
        decisions: [],
        data: {},
      }).eligible,
    ).toBe(true);
  });

  it('refuses an actor who already decided', () => {
    const approval = spec({ model: 'threshold', threshold: 2, approvers: approvers(3) });

    const verdict = checkApproverEligibility({
      approval,
      actor: actor('u1'),
      initiatedById: 'u_maker',
      decisions: [decision('u1', 'approve', 'a1')],
      data: {},
    });

    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('already_decided');
  });

  it('refuses everybody once the step is settled', () => {
    const approval = spec({ model: 'threshold', threshold: 3, approvers: approvers(3) });

    const verdict = checkApproverEligibility({
      approval,
      actor: actor('u2'),
      initiatedById: 'u_maker',
      decisions: [decision('u1', 'reject')],
      data: {},
    });

    expect(verdict.reason).toBe('already_settled');
  });

  it('distinguishes a missing permission from a missing role', () => {
    const withRole = spec({
      model: 'single',
      approvers: [
        {
          key: 'a1',
          name: 'Senior reviewer',
          permission: 'workflow.approval.decide',
          role: 'senior_reviewer',
          slaMinutes: null,
        },
      ],
    });

    // Holds the permission, not the role. Telling them "you lack the permission" would
    // send them looking for the wrong grant.
    expect(
      checkApproverEligibility({
        approval: withRole,
        actor: actor('u1', { roles: ['workflow_checker'] }),
        initiatedById: 'u_maker',
        decisions: [],
        data: {},
      }).reason,
    ).toBe('missing_role');

    expect(
      checkApproverEligibility({
        approval: spec({ model: 'single' }),
        actor: actor('u1', { permissions: [] }),
        initiatedById: 'u_maker',
        decisions: [],
        data: {},
      }).reason,
    ).toBe('missing_permission');
  });

  it('reports which slot the actor would fill', () => {
    const approval = spec({ model: 'sequential', approvers: approvers(2, true) });

    const verdict = checkApproverEligibility({
      approval,
      actor: actor('u1'),
      initiatedById: 'u_maker',
      decisions: [],
      data: {},
    });

    // The slot key is what a decision records, so an auditor sees *which* of several
    // required reviews a signature was.
    expect(verdict.approverKey).toBe('a1');
  });

  it('treats the wildcard permission as holding everything', () => {
    expect(
      checkApproverEligibility({
        approval: spec({ model: 'single' }),
        actor: actor('u1', { permissions: ['*'] }),
        initiatedById: 'u_maker',
        decisions: [],
        data: {},
      }).eligible,
    ).toBe(true);
  });
});

describe('describing progress', () => {
  it('names the next approver for a sequential model', () => {
    const approval = spec({ model: 'sequential', approvers: approvers(2, true) });
    const progress = evaluateApproval({ approval, decisions: [], data: {} });

    expect(describeNextApproval(progress)).toBe('Awaiting Approver 1.');
  });

  it('reports the remaining count for a threshold model', () => {
    const approval = spec({ model: 'threshold', threshold: 2, approvers: approvers(3) });
    const progress = evaluateApproval({ approval, decisions: [], data: {} });

    // A population, not a person — which is the honest answer for every model except
    // sequential.
    expect(describeNextApproval(progress)).toContain('2 of 2');
  });

  it('reports the terminal outcomes plainly', () => {
    const approval = spec({ model: 'single' });

    expect(
      describeNextApproval(
        evaluateApproval({ approval, decisions: [decision('u1', 'approve', 'a1')], data: {} }),
      ),
    ).toBe('Fully approved.');

    expect(
      describeNextApproval(
        evaluateApproval({ approval, decisions: [decision('u1', 'reject')], data: {} }),
      ),
    ).toBe('Rejected.');
  });
});
