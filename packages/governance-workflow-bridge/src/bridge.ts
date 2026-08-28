import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { isSameActor } from '@trustos/workflow-core';

/**
 * The approval and case experience.
 *
 * The Governance Tool provides the **user experience** for approvals. TrustOS Workflow remains
 * authoritative for the state. That sentence has a concrete consequence that this package exists
 * to enforce: **the frontend never holds approval state.**
 *
 * The failure it prevents is one every approval UI eventually has. The screen caches "2 of 3
 * approved" to avoid a round trip; somebody approves in another tab; the cached screen submits
 * the third approval against a step that already advanced; and the engine — correctly — refuses.
 * Handled badly, the team adds a retry. Handled worse, they add a "force" flag.
 *
 * So what this package models is a **view**: derived, timestamped, and explicitly stale. Every
 * decision submitted carries the version the view was built at, and the bridge refuses a decision
 * built against a stale view rather than submitting it and hoping.
 *
 * The self-approval refusal is here **as well as** in the engine. That is not redundancy: the
 * engine's refusal is the control, and this one is the affordance — a button that is refused
 * after being pressed teaches somebody to press it, and a button that is not rendered teaches
 * them the rule.
 */

export const APPROVAL_ACTIONS = [
  'approve',
  'reject',
  'return_for_rework',
  'reassign',
  'delegate',
  'escalate',
  'comment',
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const approvalViewSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    instanceId: z.string().min(1).max(80),
    organizationId: z.string().min(1).max(80),

    /** What is being approved, in a sentence somebody outside the process can read. */
    subject: z.string().min(1).max(300),
    /** The maker. Compared against the viewer, so the approve button is not rendered for them. */
    requestedById: z.string().min(1).max(80),
    requestedAt: z.string().datetime(),

    currentState: z.string().min(1).max(60),
    /** Levels required, and which have decided. Derived from the trail, never counted separately. */
    requiredLevels: z.array(z.string().max(60)).max(20),
    decidedLevels: z.array(z.string().max(60)).max(20),

    dueAt: z.string().datetime().nullable(),
    slaBreached: z.boolean(),

    /** The engine's version at the moment this view was built. Submitted back with every decision. */
    version: z.number().int().min(0),
    builtAt: z.string().datetime(),
  })
  .strict();

export type ApprovalView = z.infer<typeof approvalViewSchema>;

export interface ViewerCapabilities {
  /** Actions the viewer may see a button for. Derived; never the authorization decision. */
  available: ApprovalAction[];
  /** Actions deliberately withheld, with the reason shown beside the disabled control. */
  withheld: Array<{ action: ApprovalAction; reason: string }>;
}

export interface ViewerContext {
  actorId: string;
  /** Permissions resolved server-side. The Governance Tool's, not the engine's. */
  permissions: readonly string[];
  /** Whether the viewer already recorded a decision on this task. */
  alreadyDecided: boolean;
}

/**
 * What the viewer may see a button for.
 *
 * Every withholding carries a reason, and the reason is shown. A disabled button with no
 * explanation produces a support ticket; a disabled button that says "you submitted this" does
 * not, and it teaches the rule at the moment somebody is trying to break it.
 */
export function capabilitiesFor(view: ApprovalView, viewer: ViewerContext): ViewerCapabilities {
  const available: ApprovalAction[] = [];
  const withheld: ViewerCapabilities['withheld'] = [];

  const isMaker = isSameActor(view.requestedById, viewer.actorId);
  const canDecide = viewer.permissions.some((permission) => permission.endsWith('.approve'));

  for (const action of APPROVAL_ACTIONS) {
    if (action === 'comment') {
      available.push(action);
      continue;
    }

    if ((action === 'approve' || action === 'reject') && isMaker) {
      withheld.push({
        action,
        reason: 'You submitted this. Somebody else decides it.',
      });
      continue;
    }

    if ((action === 'approve' || action === 'reject') && viewer.alreadyDecided) {
      withheld.push({
        action,
        reason: 'You have already recorded a decision on this task.',
      });
      continue;
    }

    if ((action === 'approve' || action === 'reject') && !canDecide) {
      withheld.push({ action, reason: 'You do not hold an approval permission for this.' });
      continue;
    }

    available.push(action);
  }

  return { available, withheld };
}

export const decisionSubmissionSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    action: z.enum(APPROVAL_ACTIONS),
    /** The version the view carried. The engine refuses a stale one; so does this. */
    expectedVersion: z.number().int().min(0),
    actorId: z.string().min(1).max(80),
    reason: z.string().max(1000).optional(),
    /** Where the decision was made from. Carried into the audit record. */
    appId: z.string().min(1).max(80),
    correlationId: z.string().min(1).max(120),
  })
  .strict()
  .superRefine((submission, ctx) => {
    if (
      (submission.action === 'reject' || submission.action === 'return_for_rework') &&
      (submission.reason ?? '').trim().length < 10
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message:
          'A rejection needs a reason. "No" sends the requester back to guess, and they guess ' +
          'wrong and resubmit.',
      });
    }
  });

export type DecisionSubmission = z.infer<typeof decisionSubmissionSchema>;

/**
 * Refuses a decision built against a view that has moved on.
 *
 * The alternative — submitting and letting the engine refuse — is correct and produces a worse
 * experience: the engine's refusal arrives as a conflict the UI has to explain, and the usual
 * explanation somebody reaches for is a retry.
 */
export function assertViewFresh(view: ApprovalView, submission: DecisionSubmission): void {
  if (view.version === submission.expectedVersion) return;

  throw new ApiError('conflict', {
    message:
      'This task has changed since the screen was loaded — somebody else has acted on it. ' +
      'Reload and look again before deciding.',
    context: {
      taskId: view.taskId,
      viewVersion: view.version,
      submittedVersion: submission.expectedVersion,
    },
  });
}

/** Refuses the maker deciding their own request, before the engine has to. */
export function assertNotSelfApproval(view: ApprovalView, submission: DecisionSubmission): void {
  if (submission.action !== 'approve' && submission.action !== 'reject') return;
  if (!isSameActor(view.requestedById, submission.actorId)) return;

  throw new ApiError('forbidden', {
    message:
      'You submitted this request and cannot decide it. The engine refuses this too; the ' +
      'refusal here is so the button is not offered in the first place.',
    context: { taskId: view.taskId },
  });
}

/**
 * Progress, derived from the trail.
 *
 * Never a stored counter. A counter on the view is the design that produces "2 of 3" beside one
 * recorded decision, and the number everybody believes is the counter.
 */
export function approvalProgress(view: ApprovalView): {
  satisfied: number;
  required: number;
  outstanding: string[];
  complete: boolean;
} {
  const decided = new Set(view.decidedLevels);
  const outstanding = view.requiredLevels.filter((level) => !decided.has(level));

  return {
    satisfied: view.requiredLevels.length - outstanding.length,
    required: view.requiredLevels.length,
    outstanding,
    complete: outstanding.length === 0,
  };
}

/**
 * The case view.
 *
 * The same shape and the same rule: a view, with a version, and no authoritative state. Cases are
 * `@trustos/case-management`'s; this describes what a console renders.
 */
export const caseViewSchema = z
  .object({
    caseId: z.string().min(1).max(80),
    organizationId: z.string().min(1).max(80),
    type: z.string().min(1).max(60),
    status: z.string().min(1).max(40),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    ownerId: z.string().max(80).nullable(),
    openedAt: z.string().datetime(),
    slaDueAt: z.string().datetime().nullable(),
    slaBreached: z.boolean(),
    /** Counts, not contents. A case list that carried every comment would be a case list nobody loads. */
    commentCount: z.number().int().min(0),
    evidenceCount: z.number().int().min(0),
    version: z.number().int().min(0),
  })
  .strict();

export type CaseView = z.infer<typeof caseViewSchema>;

/** Cases whose SLA has passed, most overdue first. What a queue opens with. */
export function overdueCases(cases: readonly CaseView[], now: Date): CaseView[] {
  return cases
    .filter((entry) => entry.slaDueAt !== null && new Date(entry.slaDueAt) < now)
    .sort((left, right) => (left.slaDueAt ?? '').localeCompare(right.slaDueAt ?? ''));
}
