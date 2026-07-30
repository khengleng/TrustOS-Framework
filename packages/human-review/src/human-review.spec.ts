import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@trustos/errors';
import { DEFAULT_SLA_MS, ReviewService } from './review';
import { InMemoryReviewStore } from './testing';

/**
 * The tests that matter are the ones about *not* using output.
 *
 * A review queue whose pending items can be read is a review queue that gets bypassed on a busy
 * afternoon, and the record afterwards still says the output was reviewed.
 */

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function service(options: { allowSelfReview?: boolean } = {}) {
  const store = new InMemoryReviewStore();
  const audit = { record: vi.fn() };

  const reviews = new ReviewService({
    store,
    audit,
    ...options,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { store, audit, reviews };
}

const request = (reviews: ReviewService, overrides: Record<string, unknown> = {}) =>
  reviews.request({
    organizationId: 'org_a',
    subjectType: 'agent_run',
    subjectId: 'run_1',
    content: 'Your refund of $40 has been approved.',
    reason: 'The security reviewer agent requires every output to be reviewed.',
    requestedBy: 'usr_author',
    ...overrides,
  });

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('pending output', () => {
  it('cannot be read', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await expect(reviews.result(item.id, 'org_a')).rejects.toThrow(/still awaiting review/);
    expect(await reviews.isUsable(item.id, 'org_a')).toBe(false);
  });

  it('cannot be read after a rejection either', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'reject',
      note: 'We never approved this refund.',
    });

    await expect(reviews.result(item.id, 'org_a')).rejects.toThrow(
      /was rejected and must not be used/,
    );
  });

  it('becomes readable once approved', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    clock = new Date(clock.getTime() + 60_000);

    await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'approve',
    });

    expect(await reviews.result(item.id, 'org_a')).toEqual({
      content: 'Your refund of $40 has been approved.',
      corrected: false,
      approvedBy: 'usr_reviewer',
      approvedAt: clock,
    });
  });

  it('returns the correction rather than the original', async () => {
    // A correction that is filed and unused is the reviewer's time wasted and the original text
    // still shipping.
    const { reviews } = service();
    const item = await request(reviews);

    await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'approve',
      correctedContent: 'Your refund request has been received and is being checked.',
    });

    expect(await reviews.result(item.id, 'org_a')).toMatchObject({
      content: 'Your refund request has been received and is being checked.',
      corrected: true,
    });
  });
});

describe('who may decide', () => {
  it('refuses the person who raised it', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_a',
        actor: { actorId: 'usr_author' },
        decision: 'approve',
      }),
    ).rejects.toThrow(/cannot decide it/);
  });

  it('allows self-review only when it is deliberately switched on', async () => {
    const { reviews } = service({ allowSelfReview: true });
    const item = await request(reviews);

    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_a',
        actor: { actorId: 'usr_author' },
        decision: 'approve',
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('does not block review of an item nobody claims to have raised', async () => {
    // A machine-raised request has no author, and treating null as "same person" would make an
    // automatic request unreviewable by anyone.
    const { reviews } = service();
    const item = await request(reviews, { requestedBy: null });

    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_a',
        actor: { actorId: null },
        decision: 'approve',
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('enforces the required permission', async () => {
    const { reviews } = service();
    const item = await request(reviews, { requiredPermission: 'ai.review.security' });

    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_a',
        actor: { actorId: 'usr_reviewer', permissions: ['ai.review.support'] },
        decision: 'approve',
      }),
    ).rejects.toThrow(/needs the "ai\.review\.security" permission/);
  });

  it('does not let one tenant see another’s queue', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await expect(reviews.result(item.id, 'org_b')).rejects.toBeInstanceOf(ApiError);
    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_b',
        actor: { actorId: 'usr_reviewer' },
        decision: 'approve',
      }),
    ).rejects.toThrow(/No review request/);
  });
});

describe('decisions', () => {
  it('requires a reason for anything but an approval', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    for (const decision of ['reject', 'request_changes', 'escalate'] as const) {
      await expect(
        reviews.decide({
          id: item.id,
          organizationId: 'org_a',
          actor: { actorId: 'usr_reviewer' },
          decision,
        }),
      ).rejects.toThrow(/needs a reason/);
    }
  });

  it('treats whitespace as no reason', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_a',
        actor: { actorId: 'usr_reviewer' },
        decision: 'reject',
        note: '   ',
      }),
    ).rejects.toThrow(/needs a reason/);
  });

  it('refuses a second decision on a decided review', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'approve',
    });

    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_a',
        actor: { actorId: 'usr_other' },
        decision: 'reject',
        note: 'Actually no.',
      }),
    ).rejects.toThrow(/already approved by usr_reviewer/);
  });

  it('keeps an escalated review open and reassigns it', async () => {
    // Escalation is not a decision about the content. Closing it here would lose the item.
    const { reviews } = service();
    const item = await request(reviews);

    const escalated = await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'escalate',
      note: 'This commits us to a refund; needs a manager.',
      escalateTo: 'usr_manager',
    });

    expect(escalated).toMatchObject({
      status: 'escalated',
      assignedTo: 'usr_manager',
      decidedBy: null,
    });

    await expect(
      reviews.decide({
        id: item.id,
        organizationId: 'org_a',
        actor: { actorId: 'usr_manager' },
        decision: 'approve',
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it('lets a changes_requested item come back and be approved', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'request_changes',
      note: 'Do not state an amount we have not confirmed.',
    });

    const approved = await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'approve',
      correctedContent: 'Your refund request is being checked.',
    });

    expect(approved.status).toBe('approved');
    expect(approved.history.map((event) => event.action)).toEqual([
      'requested',
      'request_changes',
      'approve',
    ]);
  });

  it('audits the decision with its reason', async () => {
    const { reviews, audit } = service();
    const item = await request(reviews);

    await reviews.decide({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'reject',
      note: 'We never approved this refund.',
    });

    expect(audit.record.mock.calls[1]![0]).toMatchObject({
      action: 'agent.review.reject',
      actorId: 'usr_reviewer',
      before: { status: 'pending' },
      after: { status: 'rejected', note: 'We never approved this refund.' },
    });
  });
});

describe('the queue', () => {
  it('gives urgent work a shorter deadline', async () => {
    const { reviews } = service();

    const urgent = await request(reviews, { priority: 'urgent' });
    const low = await request(reviews, { priority: 'low', subjectId: 'run_2' });

    expect(urgent.dueAt.getTime()).toBe(clock.getTime() + DEFAULT_SLA_MS.urgent);
    expect(low.dueAt.getTime()).toBe(clock.getTime() + DEFAULT_SLA_MS.low);
  });

  it('reports what has breached without acting on it', async () => {
    /*
     * The only automatic action a review queue could take on timeout is approving the items
     * nobody had time to look at. So it reports and a scheduled job decides.
     */
    const { reviews } = service();
    const item = await request(reviews, { priority: 'urgent' });

    clock = new Date(clock.getTime() + DEFAULT_SLA_MS.urgent + 1000);

    const overdue = await reviews.overdue('org_a');

    expect(overdue.map((entry) => entry.id)).toEqual([item.id]);
    expect(overdue[0]!.status).toBe('pending');
  });

  it('orders the queue by priority before age', async () => {
    const { reviews } = service();

    await request(reviews, { subjectId: 'old-low', priority: 'low' });
    clock = new Date(clock.getTime() + 60_000);
    await request(reviews, { subjectId: 'new-urgent', priority: 'urgent' });

    expect(
      (await reviews.pending({ organizationId: 'org_a' })).map((entry) => entry.subjectId),
    ).toEqual(['new-urgent', 'old-low']);
  });

  it('reports queue health', async () => {
    const { reviews } = service();

    await request(reviews, { subjectId: 'a', priority: 'urgent' });
    await request(reviews, { subjectId: 'b', priority: 'normal' });

    clock = new Date(clock.getTime() + DEFAULT_SLA_MS.urgent + 1000);

    expect(await reviews.stats('org_a')).toMatchObject({
      pending: 2,
      overdue: 1,
      oldestPendingAgeMs: DEFAULT_SLA_MS.urgent + 1000,
      byPriority: { urgent: 1, normal: 1, high: 0, low: 0 },
    });
  });

  it('assigns and returns to the shared queue, recording both', async () => {
    const { reviews } = service();
    const item = await request(reviews);

    await reviews.assign({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_lead' },
      assignTo: 'usr_reviewer',
    });

    const returned = await reviews.assign({
      id: item.id,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      assignTo: null,
    });

    expect(returned.assignedTo).toBeNull();
    expect(returned.history.map((event) => event.action)).toEqual([
      'requested',
      'assigned to usr_reviewer',
      'returned to the queue',
    ]);
  });
});

describe('what the reviewer sees', () => {
  it('carries the reason and the automated signals', async () => {
    // So the reviewer sees what the machine was unsure about instead of re-deriving it.
    const { reviews } = service();

    const item = await request(reviews, {
      signals: ['groundedness 0.41', 'cites a source that does not exist'],
      prompt: 'Can I get a refund on order ORD-1?',
    });

    expect(item.signals).toHaveLength(2);
    expect(item.prompt).toMatch(/ORD-1/);
    expect(item.reason).toMatch(/requires every output to be reviewed/);
  });
});
