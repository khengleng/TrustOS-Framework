import { describe, expect, it } from 'vitest';
import { PRODUCT_LIFECYCLE_STATUSES, productErrorCode } from '@trustos/financial-product-core';
import {
  EXECUTION_MACHINE,
  PRODUCT_LIFECYCLE_MACHINE,
  StateMachine,
  applyLifecycleTransition,
  checkLifecycleTransition,
  executionOutcome,
  isTerminalExecution,
  type LifecyclePrecondition,
} from './index';

function precondition(overrides: Partial<LifecyclePrecondition> = {}): LifecyclePrecondition {
  return {
    actorPermissions: [
      'financial.product.approve',
      'financial.product.publish',
      'financial.product.update',
      'financial.product.submit',
      'financial.product.pause',
    ],
    authoredById: 'usr_maker',
    actorId: 'usr_checker',
    recordedApprovalLevels: ['PRODUCT_OWNER', 'RISK', 'COMPLIANCE'],
    requiredApprovalLevels: ['PRODUCT_OWNER', 'RISK'],
    definitionUnchanged: true,
    ...overrides,
  };
}

describe('the generic machine', () => {
  it('refuses a table referring to a state it does not declare', () => {
    expect(
      () =>
        new StateMachine('broken', ['a', 'b'] as const, [
          { action: 'go', from: 'a', to: 'c' as 'b', description: 'Nowhere.' },
        ]),
    ).toThrow(/does not have/);
  });

  it('distinguishes an unknown action from a wrong state from a terminal state', () => {
    expect(PRODUCT_LIFECYCLE_MACHINE.resolve('draft', 'teleport').reason).toBe('unknown_action');
    expect(PRODUCT_LIFECYCLE_MACHINE.resolve('draft', 'approve').reason).toBe('wrong_state');
    expect(PRODUCT_LIFECYCLE_MACHINE.resolve('retired', 'activate').reason).toBe('terminal_state');
  });

  it('offers the actions that would work instead', () => {
    expect(PRODUCT_LIFECYCLE_MACHINE.availableActions('draft')).toEqual(['design']);
    expect(() => PRODUCT_LIFECYCLE_MACHINE.assert('draft', 'approve')).toThrow(
      /Available from "draft": design/,
    );
  });
});

describe('the lifecycle machine', () => {
  it('reaches every state from draft', () => {
    expect(PRODUCT_LIFECYCLE_MACHINE.unreachableFrom('draft')).toEqual([]);
    expect(PRODUCT_LIFECYCLE_MACHINE.reachableFrom('draft').size).toBe(
      PRODUCT_LIFECYCLE_STATUSES.length,
    );
  });

  it('makes retired terminal', () => {
    expect(PRODUCT_LIFECYCLE_MACHINE.isTerminal('retired')).toBe(true);
  });

  it('has no path from draft to active without passing through approved', () => {
    // Walk every path of bounded length and assert none reaches `active` without `approved`.
    const paths: Array<{ state: string; seen: string[] }> = [{ state: 'draft', seen: ['draft'] }];

    while (paths.length > 0) {
      const current = paths.pop() as { state: string; seen: string[] };
      if (current.seen.length > 12) continue;

      for (const action of PRODUCT_LIFECYCLE_MACHINE.availableActions(current.state as never)) {
        const next = PRODUCT_LIFECYCLE_MACHINE.assert(current.state as never, action).to;
        if (current.seen.includes(next)) continue;

        if (next === 'active') {
          expect(current.seen).toContain('approved');
        }
        paths.push({ state: next, seen: [...current.seen, next] });
      }
    }
  });
});

describe('lifecycle preconditions', () => {
  it('permits an approval by somebody other than the author', () => {
    const check = checkLifecycleTransition('under_review', 'approve', precondition());
    expect(check.allowed).toBe(true);
    expect(applyLifecycleTransition('under_review', 'approve', precondition())).toBe('approved');
  });

  it('refuses an approval by the author', () => {
    const check = checkLifecycleTransition(
      'under_review',
      'approve',
      precondition({ actorId: 'usr_maker' }),
    );

    expect(check.allowed).toBe(false);
    expect(check.refusals.map((refusal) => refusal.code)).toContain('self_approval');
  });

  it('reports a self-approval as its own refusal code, not as a generic denial', () => {
    try {
      applyLifecycleTransition('under_review', 'approve', precondition({ actorId: 'usr_maker' }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_self_approval_refused');
    }
  });

  it('refuses a rejection by the author too', () => {
    // A maker who can reject their own product can bounce it past a reviewer who would have
    // asked a question.
    const check = checkLifecycleTransition(
      'under_review',
      'reject',
      precondition({ actorId: 'usr_maker' }),
    );
    expect(check.refusals.map((refusal) => refusal.code)).toContain('self_approval');
  });

  it('refuses a transition the actor lacks the permission for', () => {
    const check = checkLifecycleTransition(
      'under_review',
      'approve',
      precondition({ actorPermissions: [] }),
    );
    expect(check.refusals.map((refusal) => refusal.code)).toContain('missing_permission');
  });

  it('refuses activation with an approval level missing', () => {
    const check = checkLifecycleTransition(
      'staged',
      'activate',
      precondition({
        recordedApprovalLevels: ['PRODUCT_OWNER'],
        requiredApprovalLevels: ['PRODUCT_OWNER', 'RISK'],
      }),
    );

    expect(check.allowed).toBe(false);
    expect(check.refusals[0]?.message).toContain('RISK');
  });

  it('refuses a transition when the definition no longer hashes to what was reviewed', () => {
    const check = checkLifecycleTransition(
      'approved',
      'stage',
      precondition({ definitionUnchanged: false }),
    );

    expect(check.allowed).toBe(false);
    expect(check.refusals.map((refusal) => refusal.code)).toContain('definition_changed');
  });

  it('does not apply the hash check while the definition is meant to change', () => {
    const check = checkLifecycleTransition(
      'draft',
      'design',
      precondition({ definitionUnchanged: false }),
    );
    expect(check.refusals.map((refusal) => refusal.code)).not.toContain('definition_changed');
  });

  it('reports every refusal rather than only the first', () => {
    const check = checkLifecycleTransition(
      'under_review',
      'approve',
      precondition({
        actorId: 'usr_maker',
        actorPermissions: [],
        recordedApprovalLevels: [],
        requiredApprovalLevels: ['RISK'],
      }),
    );

    expect(check.refusals.map((refusal) => refusal.code).sort()).toEqual([
      'missing_approval',
      'missing_permission',
      'self_approval',
    ]);
  });

  it('lets an incident pause a live product with no approval recorded', () => {
    const check = checkLifecycleTransition(
      'active',
      'pause',
      precondition({ recordedApprovalLevels: [], requiredApprovalLevels: ['RISK'] }),
    );
    expect(check.allowed).toBe(true);
  });
});

describe('the execution machine', () => {
  it('reaches every state from initiated', () => {
    expect(EXECUTION_MACHINE.unreachableFrom('initiated')).toEqual([]);
  });

  it('resumes a reviewed execution rather than restarting it', () => {
    // Returning to `running` matters: re-running earlier blocks would run a money-moving block
    // twice.
    expect(EXECUTION_MACHINE.assert('awaiting_review', 'review_approved').to).toBe('running');
  });

  it('unwinds a rejected review rather than simply failing', () => {
    expect(EXECUTION_MACHINE.assert('awaiting_review', 'review_rejected').to).toBe('compensating');
  });

  it('keeps a failed compensation distinguishable from a clean failure', () => {
    expect(EXECUTION_MACHINE.assert('compensating', 'compensated').to).toBe('failed');
    expect(EXECUTION_MACHINE.assert('compensating', 'compensation_failed').to).toBe(
      'compensation_failed',
    );
  });

  it('keeps a refusal distinguishable from a failure', () => {
    expect(executionOutcome('refused')).toBe('refusal');
    expect(executionOutcome('failed')).toBe('failure');
    expect(executionOutcome('completed')).toBe('success');
    expect(executionOutcome('awaiting_review')).toBe('open');
  });

  it('treats a waiting execution as not terminal', () => {
    expect(isTerminalExecution('awaiting_review')).toBe(false);
    expect(isTerminalExecution('compensation_failed')).toBe(true);
  });
});
