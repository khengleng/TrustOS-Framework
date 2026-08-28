import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ACTIONS,
  approvalProgress,
  assertNotSelfApproval,
  assertViewFresh,
  capabilitiesFor,
  caseViewSchema,
  decisionSubmissionSchema,
  overdueCases,
  type ApprovalView,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function view(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    taskId: 'tsk_1',
    instanceId: 'wfi_1',
    organizationId: 'org_a',
    subject: 'Raise the daily acceptance limit for merchant mer_9 to 10,000.',
    requestedById: 'usr_maker',
    requestedAt: NOW.toISOString(),
    currentState: 'awaiting_risk',
    requiredLevels: ['RISK', 'FINANCE'],
    decidedLevels: ['RISK'],
    dueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    slaBreached: false,
    version: 3,
    builtAt: NOW.toISOString(),
    ...overrides,
  };
}

function submission(overrides: Record<string, unknown> = {}) {
  return decisionSubmissionSchema.parse({
    taskId: 'tsk_1',
    action: 'approve',
    expectedVersion: 3,
    actorId: 'usr_checker',
    appId: 'approval-workbench',
    correlationId: 'cor_1',
    ...overrides,
  });
}

describe('what a viewer may see a button for', () => {
  it('withholds approve and reject from the requester, with a reason', () => {
    const capabilities = capabilitiesFor(view(), {
      actorId: 'usr_maker',
      permissions: ['workflow.instance.approve'],
      alreadyDecided: false,
    });

    expect(capabilities.available).not.toContain('approve');
    expect(capabilities.withheld.find((entry) => entry.action === 'approve')?.reason).toContain(
      'You submitted this',
    );
  });

  it('withholds a second decision from somebody who already decided', () => {
    const capabilities = capabilitiesFor(view(), {
      actorId: 'usr_checker',
      permissions: ['workflow.instance.approve'],
      alreadyDecided: true,
    });

    expect(capabilities.available).not.toContain('approve');
  });

  it('withholds approval from somebody with no approval permission', () => {
    const capabilities = capabilitiesFor(view(), {
      actorId: 'usr_reader',
      permissions: ['workflow.instance.read'],
      alreadyDecided: false,
    });

    expect(capabilities.available).not.toContain('approve');
    expect(capabilities.available).toContain('comment');
  });

  it('offers everything to an eligible checker', () => {
    const capabilities = capabilitiesFor(view(), {
      actorId: 'usr_checker',
      permissions: ['workflow.instance.approve'],
      alreadyDecided: false,
    });

    expect(capabilities.available).toEqual([...APPROVAL_ACTIONS]);
    expect(capabilities.withheld).toEqual([]);
  });

  it('always lets anybody comment', () => {
    const capabilities = capabilitiesFor(view(), {
      actorId: 'usr_maker',
      permissions: [],
      alreadyDecided: true,
    });

    expect(capabilities.available).toContain('comment');
  });

  it('gives a reason for every withholding', () => {
    // A disabled button with no explanation produces a support ticket; one that says why
    // teaches the rule at the moment somebody is trying to break it.
    const capabilities = capabilitiesFor(view(), {
      actorId: 'usr_maker',
      permissions: [],
      alreadyDecided: false,
    });

    for (const withheld of capabilities.withheld) {
      expect(withheld.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('staleness', () => {
  it('accepts a decision built against the current version', () => {
    expect(() => assertViewFresh(view(), submission())).not.toThrow();
  });

  it('refuses a decision built against a view that has moved on', () => {
    // The alternative is submitting and letting the engine refuse, which arrives as a conflict
    // the UI has to explain — and the usual explanation somebody reaches for is a retry.
    expect(() => assertViewFresh(view({ version: 4 }), submission())).toThrow(
      /somebody else has acted on it/,
    );
  });
});

describe('self-approval', () => {
  it('refuses the maker approving, before the engine has to', () => {
    expect(() => assertNotSelfApproval(view(), submission({ actorId: 'usr_maker' }))).toThrow(
      /cannot decide it/,
    );
  });

  it('refuses the maker rejecting too', () => {
    expect(() =>
      assertNotSelfApproval(
        view(),
        submission({ actorId: 'usr_maker', action: 'reject', reason: 'Changed my mind about it.' }),
      ),
    ).toThrow();
  });

  it('permits the maker commenting', () => {
    expect(() =>
      assertNotSelfApproval(view(), submission({ actorId: 'usr_maker', action: 'comment' })),
    ).not.toThrow();
  });
});

describe('decisions', () => {
  it('refuses a rejection with no reason', () => {
    expect(() => submission({ action: 'reject' })).toThrow(/needs a reason/);
  });

  it('refuses a rework with no reason', () => {
    expect(() => submission({ action: 'return_for_rework', reason: 'no' })).toThrow();
  });

  it('accepts an approval without one', () => {
    expect(() => submission({ action: 'approve' })).not.toThrow();
  });
});

describe('progress', () => {
  it('is derived from the trail rather than counted', () => {
    // A counter on the view is the design that produces "2 of 3" beside one recorded decision.
    const progress = approvalProgress(view());

    expect(progress.satisfied).toBe(1);
    expect(progress.required).toBe(2);
    expect(progress.outstanding).toEqual(['FINANCE']);
    expect(progress.complete).toBe(false);
  });

  it('is complete when every level has decided', () => {
    expect(approvalProgress(view({ decidedLevels: ['RISK', 'FINANCE'] })).complete).toBe(true);
  });
});

describe('cases', () => {
  const overdue = caseViewSchema.parse({
    caseId: 'cas_1',
    organizationId: 'org_a',
    type: 'aml_review',
    status: 'open',
    priority: 'high',
    ownerId: 'usr_risk',
    openedAt: NOW.toISOString(),
    slaDueAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    slaBreached: true,
    commentCount: 3,
    evidenceCount: 1,
    version: 2,
  });

  it('carries counts rather than contents', () => {
    // A case list that carried every comment would be a case list nobody loads.
    expect(overdue.commentCount).toBe(3);
    expect(Object.keys(overdue)).not.toContain('comments');
  });

  it('sorts the most overdue first', () => {
    const later = caseViewSchema.parse({
      ...overdue,
      caseId: 'cas_2',
      slaDueAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });

    expect(overdueCases([later, overdue], NOW).map((entry) => entry.caseId)).toEqual([
      'cas_1',
      'cas_2',
    ]);
  });

  it('leaves a case inside its SLA out', () => {
    const inTime = caseViewSchema.parse({
      ...overdue,
      slaDueAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      slaBreached: false,
    });

    expect(overdueCases([inTime], NOW)).toEqual([]);
  });
});
