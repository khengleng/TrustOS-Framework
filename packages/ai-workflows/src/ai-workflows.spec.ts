import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@trustos/event-sdk';
import { InMemoryReviewStore, ReviewService } from '@trustos/human-review';
import { AI_EVENTS, AiWorkflowStep } from './steps';

/**
 * The suspension tests are the point.
 *
 * A step that waits for a person inside the process holds a thread and an in-memory continuation
 * for hours, and a deploy in the middle loses the work with no record of what it was waiting for.
 */

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

const actor = { type: 'user' as const, id: 'usr_1', displayName: 'Dara' };

function setup(options: { withReviews?: boolean; publish?: () => Promise<void> } = {}) {
  const published: EventEnvelope[] = [];
  const reviewStore = new InMemoryReviewStore();

  const reviews = new ReviewService({
    store: reviewStore,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  const publish = vi.fn(async (event: EventEnvelope) => {
    published.push(event);
    if (options.publish) await options.publish();
  });

  const step = new AiWorkflowStep({
    publish,
    ...(options.withReviews === false ? {} : { reviews }),
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  });

  return { step, reviews, reviewStore, published, publish };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  workflowId: 'wf_1',
  stepId: 'draft-reply',
  organizationId: 'org_a' as string | null,
  actor,
  run: async () => ({ output: 'Your refund is being checked.', costCents: 0.4 }),
  ...overrides,
});

const nameOf = (events: EventEnvelope[]) => events.map((event) => event.name);

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('a step that does not need review', () => {
  it('completes and returns the output', async () => {
    const { step, published } = setup();

    const result = await step.execute(input());

    expect(result).toMatchObject({
      status: 'completed',
      output: 'Your refund is being checked.',
      reviewId: null,
      costCents: 0.4,
    });
    expect(nameOf(published)).toEqual([AI_EVENTS.COMPLETED]);
  });

  it('does not put the answer in the event', async () => {
    // An event fans out to every subscriber, is logged by several and retained by all.
    const { step, published } = setup();

    await step.execute(input());

    expect(JSON.stringify(published[0]!.payload)).not.toMatch(/refund is being checked/);
    expect(published[0]!.payload).toMatchObject({ workflowId: 'wf_1', stepId: 'draft-reply' });
  });
});

describe('a step that needs review', () => {
  it('suspends rather than blocking, and withholds the output', async () => {
    const { step, published } = setup();

    const result = await step.execute(
      input({
        run: async () => ({
          output: 'We will refund you $40 today.',
          needsReview: true,
          reviewReason: 'This commits the business to a refund.',
        }),
      }),
    );

    expect(result).toMatchObject({ status: 'awaiting_review', output: null });
    expect(result.reviewId).toMatch(/^rev_/);
    expect(nameOf(published)).toEqual([AI_EVENTS.REVIEW_REQUESTED]);
  });

  it('carries a serialisable continuation, so a restart cannot lose it', async () => {
    const { step, published } = setup();

    await step.execute(
      input({
        state: { ticketId: 'tkt_9', customerId: 'cus_3' },
        run: async () => ({ output: 'x', needsReview: true }),
      }),
    );

    const payload = published[0]!.payload as { continuation: unknown };

    expect(payload.continuation).toEqual({
      workflowId: 'wf_1',
      stepId: 'draft-reply',
      state: { ticketId: 'tkt_9', customerId: 'cus_3' },
    });
    // Serialisable is the requirement, so a round trip must survive.
    expect(JSON.parse(JSON.stringify(payload.continuation))).toEqual(payload.continuation);
  });

  it('can be forced by the workflow even when the run was happy', async () => {
    const { step } = setup();

    const result = await step.execute(input({ requireReview: true }));

    expect(result.status).toBe('awaiting_review');
  });

  it('passes the automated signals to the reviewer', async () => {
    const { step, reviewStore } = setup();

    const result = await step.execute(
      input({
        run: async () => ({
          output: 'x',
          needsReview: true,
          signals: ['groundedness 0.41'],
          prompt: 'Can I get a refund?',
        }),
      }),
    );

    expect(reviewStore.requests.get(result.reviewId!)).toMatchObject({
      signals: ['groundedness 0.41'],
      prompt: 'Can I get a refund?',
      subjectId: 'wf_1:draft-reply',
    });
  });

  it('refuses to continue when no review service is wired', async () => {
    /*
     * The alternative is worse than an error: a step whose whole point is that a person checks it
     * silently stops being checked because somebody forgot a line of wiring.
     */
    const { step } = setup({ withReviews: false });

    await expect(
      step.execute(input({ run: async () => ({ output: 'x', needsReview: true }) })),
    ).rejects.toThrow(/no review service is configured/i);
  });
});

describe('resuming', () => {
  const suspend = async (step: AiWorkflowStep) =>
    step.execute(
      input({ run: async () => ({ output: 'We will refund you $40.', needsReview: true }) }),
    );

  it('returns the approved output', async () => {
    const { step, reviews } = setup();
    const suspended = await suspend(step);

    await reviews.decide({
      id: suspended.reviewId!,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'approve',
    });

    const resumed = await step.resume({
      reviewId: suspended.reviewId!,
      organizationId: 'org_a',
      actor,
    });

    expect(resumed).toMatchObject({ status: 'completed', output: 'We will refund you $40.' });
  });

  it('returns the reviewer’s correction rather than the original', async () => {
    const { step, reviews } = setup();
    const suspended = await suspend(step);

    await reviews.decide({
      id: suspended.reviewId!,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'approve',
      correctedContent: 'We are checking your refund request.',
    });

    expect(
      await step.resume({ reviewId: suspended.reviewId!, organizationId: 'org_a', actor }),
    ).toMatchObject({ output: 'We are checking your refund request.' });
  });

  it('treats a rejection as a branch, not an error', async () => {
    const { step, reviews } = setup();
    const suspended = await suspend(step);

    await reviews.decide({
      id: suspended.reviewId!,
      organizationId: 'org_a',
      actor: { actorId: 'usr_reviewer' },
      decision: 'reject',
      note: 'We never approved this refund.',
    });

    const resumed = await step.resume({
      reviewId: suspended.reviewId!,
      organizationId: 'org_a',
      actor,
    });

    expect(resumed).toMatchObject({
      status: 'failed',
      output: null,
      reason: 'review_not_approved',
    });
  });

  it('does not resume a review that is still pending', async () => {
    const { step } = setup();
    const suspended = await suspend(step);

    expect(
      await step.resume({ reviewId: suspended.reviewId!, organizationId: 'org_a', actor }),
    ).toMatchObject({ status: 'failed', reason: 'review_not_approved' });
  });

  it('does not resume another tenant’s review', async () => {
    const { step } = setup();
    const suspended = await suspend(step);

    expect(
      await step.resume({ reviewId: suspended.reviewId!, organizationId: 'org_b', actor }),
    ).toMatchObject({ status: 'failed' });
  });
});

describe('failure', () => {
  it('returns a reason the workflow can branch on rather than throwing', async () => {
    // An exception thrown through a step handler is a failure the workflow definition cannot see.
    const { step, published } = setup();

    const result = await step.execute(
      input({
        run: async () => {
          throw new Error('The provider is unreachable.');
        },
      }),
    );

    expect(result).toMatchObject({ status: 'failed', reason: 'run_failed', output: null });
    expect(nameOf(published)).toEqual([AI_EVENTS.FAILED]);
  });

  it('carries a guardrail refusal through as its own reason', async () => {
    const { step } = setup();

    const { AiError } = await import('@trustos/ai-sdk');

    const result = await step.execute(
      input({
        run: async () => {
          throw AiError.guardrailBlocked('The prompt contained a card number.');
        },
      }),
    );

    expect(result.reason).toBe('guardrail_blocked');
  });

  it('does not put the prompt in a failure event', async () => {
    const { step, published } = setup();

    await step.execute(
      input({
        run: async () => {
          throw new Error('Rejected input: "my card is 4111 1111 1111 1111"');
        },
      }),
    );

    // The message is truncated and carried, so the detail is visible — but it is the error's
    // message, never the prompt the step was given.
    expect(published[0]!.payload).toMatchObject({ reason: 'run_failed' });
    expect(JSON.stringify(published[0]!.payload)).not.toMatch(/Your refund is being checked/);
  });

  it('does not lose a completed step because the bus was down', async () => {
    // The model was already paid for. Throwing here makes the workflow retry a completed call.
    const { step } = setup({
      publish: async () => {
        throw new Error('The event bus is unavailable.');
      },
    });

    await expect(step.execute(input())).resolves.toMatchObject({ status: 'completed' });
  });
});

describe('other events', () => {
  it('announces a budget threshold with how much is used', async () => {
    const { step } = setup();

    const event = await step.budgetWarning({
      organizationId: 'org_a',
      actor,
      scope: 'organization:org_a',
      spentCents: 900,
      limitCents: 1000,
      severity: 'warning',
    });

    expect(event.name).toBe(AI_EVENTS.BUDGET_WARNING);
    expect(event.payload).toMatchObject({ usedFraction: 0.9, severity: 'warning' });
  });

  it('announces an evaluation regression per case', async () => {
    // An event carrying a changed average tells a subscriber that something moved and nothing
    // about what.
    const { step } = setup();

    const event = await step.evaluationRegressed({
      organizationId: 'org_a',
      actor,
      suiteId: 'support-answers',
      subject: 'support-agent',
      variant: 'prompt-v4',
      regressions: [{ caseId: 'refund-window', metric: 'groundedness', from: 0.81, to: 0.42 }],
      newFailures: ['refund-window'],
    });

    expect(event.payload).toMatchObject({
      regressionCount: 1,
      newFailures: ['refund-window'],
      regressions: [expect.objectContaining({ caseId: 'refund-window' })],
    });
  });
});

describe('event plumbing', () => {
  it('keeps every event of one step on the same correlation id', async () => {
    const { step, published } = setup();

    const suspended = await step.execute(
      input({ correlationId: 'corr_fixed', run: async () => ({ output: 'x', needsReview: true }) }),
    );

    await step.resume({
      reviewId: suspended.reviewId!,
      organizationId: 'org_a',
      actor,
      correlationId: 'corr_fixed',
    });

    expect(published.map((event) => event.metadata.correlationId)).toEqual([
      'corr_fixed',
      'corr_fixed',
    ]);
  });

  it('returns the events it published, so a caller can record them', async () => {
    const { step } = setup();

    const result = await step.execute(input());

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.organizationId).toBe('org_a');
  });
});
