import { ApiError } from '@trustsystem/errors';
import { backoffDelay, DEFAULT_RETRY_POLICY, isRetryableError, type RetryPolicy } from './policy';

/**
 * Executing with retry.
 *
 * One function, `withRetry`, and a small amount of machinery around cancellation and timeouts.
 * The interesting behaviour is what it refuses to do:
 *
 *   * It does not swallow the error. The final failure is the *original* error, not a wrapper —
 *     an operator debugging a dead letter needs the actual message, and "retry exhausted" tells
 *     them nothing they could act on.
 *   * It does not retry a non-retryable error even once. A 400 fails immediately.
 *   * It does not sleep after the last attempt. Waiting thirty seconds to then give up is thirty
 *     seconds of nothing.
 */

export interface RetryAttempt {
  /** 1-based. Attempt 1 is the initial call. */
  attempt: number;
  error: unknown;
  /** Delay before the *next* attempt. Zero on the final one. */
  delayMs: number;
  /** Whether the error was classified retryable. */
  retryable: boolean;
}

export interface RetryContext {
  /** For logs and for a dead-letter record. */
  operation: string;
  policy: RetryPolicy;
  attempts: RetryAttempt[];
  /** Wall-clock milliseconds across every attempt, including the waits. */
  elapsedMs: number;
}

export interface WithRetryOptions {
  /** Names the operation in logs and in the exhaustion error. */
  operation: string;
  policy?: RetryPolicy;
  signal?: AbortSignal;
  /** Overrides the classification for a caller that knows its own errors. */
  isRetryable?: (error: unknown) => boolean;
  /**
   * Called before each wait.
   *
   * Where a caller records a metric or a log line. It must not throw — an observer that threw
   * would turn a retryable failure into a permanent one, so a throw here is swallowed.
   */
  onRetry?: (attempt: RetryAttempt) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface RetryOutcome<T> {
  value: T;
  /** 1 when it succeeded first time. */
  attempts: number;
  elapsedMs: number;
}

/**
 * Thrown when every attempt failed.
 *
 * Carries the original error as `cause`, because that is the one a person needs. `context` has
 * the attempt history for a dead-letter record.
 */
export class RetryExhaustedError extends Error {
  readonly context: RetryContext;

  constructor(context: RetryContext, cause: unknown) {
    const last = context.attempts.at(-1);
    super(
      `"${context.operation}" failed after ${context.attempts.length} attempt(s) over ` +
        `${Math.round(context.elapsedMs)}ms: ${describeError(last?.error)}`,
    );
    this.name = 'RetryExhaustedError';
    this.context = context;
    this.cause = cause;
  }
}

/** Thrown when the total budget ran out mid-flight. */
export class RetryTimeoutError extends Error {
  readonly context: RetryContext;

  constructor(context: RetryContext) {
    super(
      `"${context.operation}" exceeded its ${context.policy.totalTimeoutMs}ms total timeout ` +
        `after ${context.attempts.length} attempt(s).`,
    );
    this.name = 'RetryTimeoutError';
    this.context = context;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

/**
 * A cancellable sleep.
 *
 * The timer is cleared on abort. A `setTimeout` left running holds the event loop open, which
 * is how a process that was asked to shut down takes thirty seconds to do it.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Runs `operation` with retry.
 *
 * The loop is deliberately small, and every branch in it is a decision documented in
 * `policy.ts`. What is worth noticing here is the ordering: the retryable check comes *before*
 * the attempt-count check, so a non-retryable error fails immediately with its own message
 * rather than after exhausting a budget it was never eligible for.
 */
export async function withRetry<T>(
  operation: (attempt: number, signal?: AbortSignal) => Promise<T>,
  options: WithRetryOptions,
): Promise<RetryOutcome<T>> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const now = options.now ?? (() => Date.now());
  const doSleep = options.sleep ?? sleep;
  const retryable = options.isRetryable ?? isRetryableError;

  const startedAt = now();
  const attempts: RetryAttempt[] = [];

  const context = (): RetryContext => ({
    operation: options.operation,
    policy,
    attempts,
    elapsedMs: now() - startedAt,
  });

  for (let attempt = 1; attempt <= policy.maxAttempts + 1; attempt += 1) {
    if (options.signal?.aborted) throw abortError();

    try {
      const value = await runAttempt(operation, attempt, policy, options.signal);
      return { value, attempts: attempt, elapsedMs: now() - startedAt };
    } catch (error) {
      // A deliberate cancellation is never retried and is never wrapped: the caller asked for
      // this and needs to recognise their own abort.
      if (isAbort(error)) throw error;

      const isLast = attempt > policy.maxAttempts;
      const canRetry = retryable(error);

      const record: RetryAttempt = {
        attempt,
        error,
        retryable: canRetry,
        delayMs: 0,
      };

      // A non-retryable error is rethrown as-is. Wrapping a 400 in "retry exhausted" would tell
      // the caller the wrong thing about their own bad request.
      if (!canRetry) {
        attempts.push(record);
        throw error;
      }

      if (isLast) {
        attempts.push(record);
        throw new RetryExhaustedError(context(), error);
      }

      const delayMs = backoffDelay(policy, attempt, options.random);

      // The total budget is checked *before* sleeping, so an operation does not wait out a
      // delay it has no time left to use.
      if (policy.totalTimeoutMs !== null) {
        const spent = now() - startedAt;
        if (spent + delayMs >= policy.totalTimeoutMs) {
          attempts.push(record);
          throw new RetryTimeoutError(context());
        }
      }

      record.delayMs = delayMs;
      attempts.push(record);

      // An observer that threw would turn a retryable failure into a permanent one, so it is
      // isolated. There is no good place to report its failure — it is the reporting.
      try {
        options.onRetry?.(record);
      } catch {
        /* ignored deliberately; see above */
      }

      await doSleep(delayMs, options.signal);
    }
  }

  // Unreachable: the loop either returns or throws. Present so the function has no implicit
  // undefined return, which would be a silent success on a path that cannot succeed.
  throw new RetryExhaustedError(context(), new Error('retry loop completed without a result'));
}

/** Runs one attempt, applying the per-attempt timeout if there is one. */
async function runAttempt<T>(
  operation: (attempt: number, signal?: AbortSignal) => Promise<T>,
  attempt: number,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  if (policy.attemptTimeoutMs === null) return operation(attempt, signal);

  /*
   * The timeout aborts the attempt's own signal, which is chained to the caller's.
   *
   * A `Promise.race` alone would resolve the race and leave the operation running — which for
   * an HTTP call means a connection nobody is reading and, at scale, a pool that never drains.
   * Passing an abort signal lets the operation actually stop.
   */
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), policy.attemptTimeoutMs);

  try {
    return await Promise.race([
      operation(attempt, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            // A timeout is retryable; a caller's abort is not. Distinguished here so the loop
            // above treats them differently.
            if (signal?.aborted) {
              reject(abortError());
              return;
            }
            const error = new Error(
              `Attempt ${attempt} exceeded its ${policy.attemptTimeoutMs}ms timeout.`,
            ) as Error & { retryable: boolean };
            error.name = 'AttemptTimeoutError';
            error.retryable = true;
            reject(error);
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/**
 * Runs an operation with a fallback.
 *
 * The fallback receives the error, so it can decide between a cached value, a degraded answer
 * and rethrowing. Returning a fallback silently would hide a downstream that has been down for
 * a week — `used` is in the result so a caller can record it.
 */
export async function withFallback<T>(
  operation: () => Promise<T>,
  fallback: (error: unknown) => Promise<T> | T,
): Promise<{ value: T; used: 'primary' | 'fallback'; error?: unknown }> {
  try {
    return { value: await operation(), used: 'primary' };
  } catch (error) {
    // A deliberate cancellation is not a failure to fall back from.
    if (isAbort(error)) throw error;
    return { value: await fallback(error), used: 'fallback', error };
  }
}

/**
 * Wraps a retry failure as an `ApiError`.
 *
 * For a caller that surfaces the result over HTTP. `rate_limited` rather than `internal`,
 * because "we tried and the downstream is not available" is a temporary condition the client
 * should retry — and a 500 tells them to file a bug.
 */
export function toApiError(error: unknown, operation: string): ApiError {
  if (error instanceof RetryExhaustedError || error instanceof RetryTimeoutError) {
    return ApiError.rateLimited(
      `${operation} is temporarily unavailable. Please try again shortly.`,
      {
        reason: 'retry_exhausted',
        attempts: error.context.attempts.length,
        elapsedMs: Math.round(error.context.elapsedMs),
      },
    );
  }

  if (error instanceof ApiError) return error;
  return ApiError.internal(`${operation} failed.`, error);
}
