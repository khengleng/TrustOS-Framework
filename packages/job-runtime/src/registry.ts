import { ApiError } from '@trustsystem/errors';
import { z } from 'zod';
import type { RetryPolicy } from '@trustsystem/retry';
import { JOB_PRIORITY } from './entities';

/**
 * The handler registry.
 *
 * Same idea as the event registry, and the same rule: a job type with no registered handler is
 * never enqueued. A job sitting in a queue no worker understands is the worst failure mode
 * available here — it looks like the system is working, right up until somebody asks where their
 * export went.
 *
 * The payload schema is what makes the check useful. Rejecting at enqueue time means the caller
 * who built a bad payload gets the error, in their own stack trace, synchronously. Validating in
 * the worker instead means the failure surfaces minutes later, in a different process, attached
 * to nothing the caller can see.
 */

export interface JobContext<TPayload = unknown> {
  jobId: string;
  organizationId: string | null;
  payload: TPayload;
  /** 1-based. Greater than 1 means a previous attempt failed. */
  attempt: number;
  /**
   * Reports progress, 0 to 100.
   *
   * Best-effort and never throws: a job must not fail because a progress write did. Called too
   * often it is a write per call, so a handler processing ten thousand rows should report every
   * hundred rather than every one.
   */
  reportProgress: (percent: number, message?: string) => Promise<void>;
  /**
   * Cancelled on shutdown, on job cancellation, and on lease loss.
   *
   * A long handler must honour it. One that does not cannot be cancelled, and its lease will
   * eventually expire and let a second worker start the same job alongside it.
   */
  signal: AbortSignal;
  metadata: Record<string, string | number | boolean | null>;
}

export interface JobHandlerDefinition<TPayload = unknown, TResult = unknown> {
  type: string;
  description: string;
  /** Validates the payload at enqueue time. */
  payload: z.ZodType<TPayload>;
  handle: (context: JobContext<TPayload>) => Promise<TResult>;

  /** Defaults to `JOB_PRIORITY.normal`. */
  priority?: number;
  /** Defaults to 3. */
  maxAttempts?: number;
  retry?: RetryPolicy;

  /**
   * Ceiling on one attempt.
   *
   * A handler that hangs holds its lease and, without a timeout, holds it forever. Null means the
   * handler is trusted to bound itself, which is worth being deliberate about rather than
   * defaulting into.
   */
  timeoutMs?: number | null;

  /**
   * How many of this type may run at once, per worker.
   *
   * For a handler that talks to something with its own limits — an external API, a database that
   * does not enjoy twenty concurrent bulk writes.
   */
  concurrency?: number;
}

interface RegisteredHandler extends JobHandlerDefinition {
  priority: number;
  maxAttempts: number;
  timeoutMs: number | null;
  concurrency: number;
}

export class JobRegistry {
  private readonly handlers = new Map<string, RegisteredHandler>();

  constructor(definitions: JobHandlerDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register<TPayload, TResult>(definition: JobHandlerDefinition<TPayload, TResult>): this {
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$/.test(definition.type)) {
      throw ApiError.validation(
        [
          {
            path: 'type',
            message: 'A job type is lowercase and dot-separated: "report.monthly_summary".',
          },
        ],
        `"${definition.type}" is not a valid job type.`,
      );
    }

    if (this.handlers.has(definition.type)) {
      // Two handlers for one type would make which runs depend on import order — and the symptom
      // is a job doing the wrong thing rather than failing.
      throw ApiError.conflict(`A handler for "${definition.type}" is already registered.`, {
        reason: 'job_handler_conflict',
        type: definition.type,
      });
    }

    this.handlers.set(definition.type, {
      ...(definition as JobHandlerDefinition),
      priority: definition.priority ?? JOB_PRIORITY.normal,
      maxAttempts: definition.maxAttempts ?? 3,
      timeoutMs: definition.timeoutMs === undefined ? 15 * 60 * 1000 : definition.timeoutMs,
      concurrency: definition.concurrency ?? 5,
    });

    return this;
  }

  registerAll(definitions: JobHandlerDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  get(type: string): RegisteredHandler {
    const handler = this.handlers.get(type);

    if (!handler) {
      const known = [...this.handlers.keys()].sort();

      throw ApiError.validation(
        [
          {
            path: 'type',
            message:
              `No handler is registered for "${type}". A job with no handler would sit in the ` +
              `queue forever. Registered types: ${known.join(', ') || '(none)'}.`,
            code: 'job_handler_unknown',
          },
        ],
        `Unknown job type "${type}".`,
      );
    }

    return handler;
  }

  /** Validates a payload against its handler's schema. Runs at enqueue time. */
  validate(type: string, payload: unknown): unknown {
    const handler = this.get(type);
    const parsed = handler.payload.safeParse(payload);

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `payload.${issue.path.join('.')}`,
          message: issue.message,
          code: 'job_payload_invalid',
        })),
        `The payload for job type "${type}" is not valid.`,
      );
    }

    return parsed.data;
  }

  types(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** For `trustos doctor integrations` and the admin UI. */
  describe(): Array<{
    type: string;
    description: string;
    priority: number;
    maxAttempts: number;
    timeoutMs: number | null;
    concurrency: number;
  }> {
    return [...this.handlers.values()]
      .map((handler) => ({
        type: handler.type,
        description: handler.description,
        priority: handler.priority,
        maxAttempts: handler.maxAttempts,
        timeoutMs: handler.timeoutMs,
        concurrency: handler.concurrency,
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  get size(): number {
    return this.handlers.size;
  }
}
