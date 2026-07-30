import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { buildEvent, type EventActor, type EventEnvelope } from '@trustos/event-sdk';
import type { LoggerPort } from '@trustos/logging';
import type { ReviewPriority, ReviewService } from '@trustos/human-review';

/**
 * AI in workflows.
 *
 * The seam between phase 5's workflow engine, phase 6's events and phase 7's AI. It exists
 * because the interesting part of putting AI in a business process is not the model call — it is
 * what happens when the answer needs a person, and a workflow that blocks a thread waiting for one
 * is a workflow that dies on the first restart.
 *
 * So an AI step has three outcomes, not two:
 *
 *   * `completed`        — the answer is ready and usable.
 *   * `awaiting_review`  — a person must look at it. The step is **suspended**, not blocked. It
 *                          returns a token, the process ends, and `resume()` picks it up when the
 *                          review is decided — possibly on a different pod, possibly next week.
 *   * `failed`           — it did not work, with a reason the workflow can branch on.
 *
 * **Suspension rather than waiting** is the design decision worth the words. A step that awaits a
 * human decision inside the process holds a connection, a thread and an in-memory continuation for
 * hours; a deploy in the middle loses all three, and the work vanishes with no record of what it
 * was waiting for. Suspension puts the continuation in the review request, where a restart cannot
 * touch it.
 *
 * **Events are emitted for what happened, not for what was said.** Payloads carry ids, outcomes,
 * costs and reasons. The answer text is not in an event, because an event fans out to every
 * subscriber, gets logged by several of them, and is retained by all of them.
 */

export const AI_EVENTS = {
  COMPLETED: 'ai.step.completed',
  REVIEW_REQUESTED: 'ai.step.review_requested',
  REVIEW_DECIDED: 'ai.step.review_decided',
  FAILED: 'ai.step.failed',
  BUDGET_WARNING: 'ai.budget.warning',
  EVALUATION_REGRESSED: 'ai.evaluation.regressed',
} as const;

export const AI_STEP_STATUSES = ['completed', 'awaiting_review', 'failed'] as const;
export type AiStepStatus = (typeof AI_STEP_STATUSES)[number];

/**
 * What the step needs to remember while a person looks at it.
 *
 * Deliberately small and serialisable. Anything not in here is lost across the suspension, which
 * is the correct pressure: a step needing a live object to resume is a step that cannot survive a
 * deploy.
 */
export const stepContinuationSchema = z
  .object({
    workflowId: z.string().max(120),
    stepId: z.string().max(120),
    /** Whatever the workflow needs to carry across. Ids and flags, not documents. */
    state: z.record(z.unknown()).default({}),
  })
  .strict();

export type StepContinuation = z.infer<typeof stepContinuationSchema>;

export interface AiStepResult {
  status: AiStepStatus;
  /** The usable output. Null while awaiting review — see the header of `human-review`. */
  output: string | null;
  parsed?: unknown;
  /** Set when suspended. Passed back to `resume()`. */
  reviewId: string | null;
  /** Set when it failed. A short reason a workflow can branch on, never a stack trace. */
  reason: string | null;
  costCents: number;
  events: EventEnvelope[];
}

export interface AiStepInput {
  workflowId: string;
  stepId: string;
  organizationId: string | null;
  actor: EventActor;
  /** Carried across a suspension. */
  state?: Record<string, unknown>;

  /** Runs the AI. An agent run, a gateway call, a RAG answer — the step does not care which. */
  run: () => Promise<{
    output: string;
    parsed?: unknown;
    costCents?: number;
    agentId?: string | null;
    modelId?: string | null;
    /** The step asks for review when this is true, whatever the policy says. */
    needsReview?: boolean;
    reviewReason?: string | null;
    /** What the automated checks were unsure about. Shown to the reviewer. */
    signals?: string[];
    /** For the reviewer's context. */
    prompt?: string | null;
  }>;

  /** Forces review regardless of what the run reported. For a high-value branch. */
  requireReview?: boolean;
  reviewPriority?: ReviewPriority;
  reviewPermission?: string | null;
  correlationId?: string;
}

export interface AiWorkflowOptions {
  /** Publishes to the phase 6 bus. */
  publish: (envelope: EventEnvelope) => Promise<void>;
  reviews?: ReviewService;
  logger?: LoggerPort;
  /** Where events say they came from. */
  source?: string;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class AiWorkflowStep {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly source: string;

  constructor(private readonly options: AiWorkflowOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.source = options.source ?? 'ai-workflows';
  }

  /**
   * Runs an AI step.
   *
   * Never throws for a failed model call. A workflow needs to branch on the failure, and an
   * exception thrown through a step handler is a failure the workflow definition cannot see.
   */
  async execute(input: AiStepInput): Promise<AiStepResult> {
    const correlationId = input.correlationId ?? this.newId('corr');
    const events: EventEnvelope[] = [];

    let outcome: Awaited<ReturnType<AiStepInput['run']>>;

    try {
      outcome = await input.run();
    } catch (caught) {
      const reason = caught instanceof ApiError ? apiErrorReason(caught) : 'run_failed';

      const event = this.event(AI_EVENTS.FAILED, input, correlationId, {
        workflowId: input.workflowId,
        stepId: input.stepId,
        reason,
        // The message, not the stack, and never the prompt.
        detail:
          caught instanceof Error ? caught.message.slice(0, 500) : String(caught).slice(0, 500),
      });

      await this.publish(event, events);

      this.options.logger?.warn(
        { workflowId: input.workflowId, stepId: input.stepId, reason },
        'ai step failed',
      );

      return {
        status: 'failed',
        output: null,
        reviewId: null,
        reason,
        costCents: 0,
        events,
      };
    }

    const costCents = outcome.costCents ?? 0;
    const needsReview = input.requireReview === true || outcome.needsReview === true;

    if (!needsReview) {
      await this.publish(
        this.event(AI_EVENTS.COMPLETED, input, correlationId, {
          workflowId: input.workflowId,
          stepId: input.stepId,
          agentId: outcome.agentId ?? null,
          modelId: outcome.modelId ?? null,
          costCents,
          reviewed: false,
        }),
        events,
      );

      return {
        status: 'completed',
        output: outcome.output,
        parsed: outcome.parsed,
        reviewId: null,
        reason: null,
        costCents,
        events,
      };
    }

    if (!this.options.reviews) {
      /*
       * Refusing is the only safe answer.
       *
       * The alternative — returning the output with a warning — means an agent whose whole point
       * is that a person checks it silently stops being checked the moment somebody forgets to
       * wire the review service. That failure is invisible until it is expensive.
       */
      throw ApiError.internal(
        `The step "${input.stepId}" produced output that requires human review, but no review ` +
          'service is configured. Returning it unreviewed would silently drop the control this ' +
          'step exists for. Wire @trustos/human-review, or do not require review here.',
        { reason: 'review_service_missing', stepId: input.stepId },
      );
    }

    const continuation = stepContinuationSchema.parse({
      workflowId: input.workflowId,
      stepId: input.stepId,
      state: input.state ?? {},
    });

    const request = await this.options.reviews.request({
      organizationId: input.organizationId,
      subjectType: 'workflow_step',
      subjectId: `${input.workflowId}:${input.stepId}`,
      content: outcome.output,
      prompt: outcome.prompt ?? null,
      agentId: outcome.agentId ?? null,
      modelId: outcome.modelId ?? null,
      reason:
        outcome.reviewReason ??
        `The "${input.stepId}" step requires a person to check the output before the process continues.`,
      signals: outcome.signals ?? [],
      priority: input.reviewPriority ?? 'normal',
      requestedBy: input.actor.id ?? null,
      requiredPermission: input.reviewPermission ?? null,
    });

    await this.publish(
      this.event(AI_EVENTS.REVIEW_REQUESTED, input, correlationId, {
        workflowId: input.workflowId,
        stepId: input.stepId,
        reviewId: request.id,
        priority: request.priority,
        dueAt: request.dueAt.toISOString(),
        // The continuation travels in the event too, so a subscriber can rebuild the step's place
        // in the process without reading the workflow store.
        continuation,
      }),
      events,
    );

    return {
      status: 'awaiting_review',
      // Null, not the text. Output awaiting review is not usable, and a field holding it is a
      // field somebody renders.
      output: null,
      reviewId: request.id,
      reason: null,
      costCents,
      events,
    };
  }

  /**
   * Resumes a suspended step once its review is decided.
   *
   * Reads the decision from the review service rather than taking it as an argument: a caller
   * passing "approved" in is a caller who can pass it in wrongly, and the review store is the
   * record of what actually happened.
   */
  async resume(input: {
    reviewId: string;
    organizationId: string | null;
    actor: EventActor;
    correlationId?: string;
  }): Promise<AiStepResult> {
    if (!this.options.reviews) {
      throw ApiError.internal(
        'No review service is configured, so a suspended step cannot resume.',
      );
    }

    const correlationId = input.correlationId ?? this.newId('corr');
    const events: EventEnvelope[] = [];

    const usable = await this.options.reviews.isUsable(input.reviewId, input.organizationId);

    if (!usable) {
      await this.publish(
        this.event(
          AI_EVENTS.REVIEW_DECIDED,
          { organizationId: input.organizationId, actor: input.actor },
          correlationId,
          { reviewId: input.reviewId, approved: false },
        ),
        events,
      );

      return {
        status: 'failed',
        output: null,
        reviewId: input.reviewId,
        // A rejection is a legitimate business outcome, so it is a reason to branch on rather
        // than an error to handle.
        reason: 'review_not_approved',
        costCents: 0,
        events,
      };
    }

    const result = await this.options.reviews.result(input.reviewId, input.organizationId);

    await this.publish(
      this.event(
        AI_EVENTS.REVIEW_DECIDED,
        { organizationId: input.organizationId, actor: input.actor },
        correlationId,
        {
          reviewId: input.reviewId,
          approved: true,
          corrected: result.corrected,
          approvedBy: result.approvedBy,
        },
      ),
      events,
    );

    return {
      status: 'completed',
      // The correction when there is one, which is what `result()` returns.
      output: result.content,
      reviewId: input.reviewId,
      reason: null,
      costCents: 0,
      events,
    };
  }

  /** Announces a budget threshold, for a subscriber that throttles or alerts. */
  async budgetWarning(input: {
    organizationId: string | null;
    actor: EventActor;
    scope: string;
    spentCents: number;
    limitCents: number;
    severity: 'warning' | 'critical';
  }): Promise<EventEnvelope> {
    const event = this.event(
      AI_EVENTS.BUDGET_WARNING,
      { organizationId: input.organizationId, actor: input.actor },
      this.newId('corr'),
      {
        scope: input.scope,
        spentCents: input.spentCents,
        limitCents: input.limitCents,
        usedFraction: Number((input.spentCents / Math.max(0.0001, input.limitCents)).toFixed(4)),
        severity: input.severity,
      },
    );

    await this.options.publish(event);
    return event;
  }

  /**
   * Announces an evaluation regression.
   *
   * Per case, matching what `@trustos/evaluation` reports — an event carrying only a changed
   * average tells a subscriber that something moved and nothing about what.
   */
  async evaluationRegressed(input: {
    organizationId: string | null;
    actor: EventActor;
    suiteId: string;
    subject: string;
    variant: string;
    regressions: Array<{ caseId: string; metric: string; from: number; to: number }>;
    newFailures: string[];
  }): Promise<EventEnvelope> {
    const event = this.event(
      AI_EVENTS.EVALUATION_REGRESSED,
      { organizationId: input.organizationId, actor: input.actor },
      this.newId('corr'),
      {
        suiteId: input.suiteId,
        subject: input.subject,
        variant: input.variant,
        newFailures: input.newFailures,
        regressions: input.regressions.slice(0, 50),
        regressionCount: input.regressions.length,
      },
    );

    await this.options.publish(event);
    return event;
  }

  private event(
    name: string,
    input: { organizationId: string | null; actor: EventActor },
    correlationId: string,
    payload: Record<string, unknown>,
  ): EventEnvelope {
    return buildEvent(
      {
        name,
        payload,
        organizationId: input.organizationId,
        actor: input.actor,
        correlationId,
        source: this.source,
      },
      { newId: () => this.newId('evt'), now: this.now },
    );
  }

  /**
   * Publishes, and does not let a publish failure lose the step's result.
   *
   * The step already happened and the model was already paid for. Throwing here would make the
   * workflow retry a completed AI call because the bus was briefly unavailable.
   */
  private async publish(event: EventEnvelope, collected: EventEnvelope[]): Promise<void> {
    collected.push(event);

    try {
      await this.options.publish(event);
    } catch (caught) {
      this.options.logger?.error(
        { event: event.name, error: caught instanceof Error ? caught.message : String(caught) },
        'failed to publish an AI workflow event',
      );
    }
  }
}

/** A short, branchable reason from an ApiError's context. */
function apiErrorReason(error: ApiError): string {
  const context = (error as unknown as { context?: { reason?: string } }).context;
  return context?.reason ?? 'run_failed';
}
