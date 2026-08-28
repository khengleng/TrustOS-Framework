import { z } from 'zod';

/**
 * Retry policy.
 *
 * Every integration in this phase retries something: an event handler, a webhook delivery, a
 * job, a sync pull. They all use this, because retry is where well-meaning code causes
 * outages and one implementation is easier to get right than six.
 *
 * The three decisions that matter, in the order they matter:
 *
 *   1. **Jitter is on by default.** Without it, N clients that failed together retry together,
 *      and the retry storm is worse than the original failure. This is the single most common
 *      way a partial outage becomes a total one, and it is invisible until it happens at scale.
 *   2. **Not every error is retryable.** Retrying a 400 forever is a client bug that looks like
 *      a server problem. `isRetryable` decides, and the default is conservative: retry what is
 *      plausibly transient, give up on what is plausibly a mistake.
 *   3. **A ceiling on the delay.** Exponential backoff without a cap reaches hours, and a job
 *      that retries in four hours is a job nobody is waiting for any more.
 */

export const BACKOFF_STRATEGIES = ['exponential', 'linear', 'fixed'] as const;
export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number];

export const JITTER_MODES = ['full', 'equal', 'none'] as const;
export type JitterMode = (typeof JITTER_MODES)[number];

export const retryPolicySchema = z
  .object({
    /**
     * Attempts *after* the first, so `maxAttempts: 3` means up to four calls.
     *
     * Named for what it bounds rather than for the total, because "3 retries" is what an
     * operator says and a policy that meant four calls when they wrote three would be a policy
     * they configure wrongly once.
     */
    maxAttempts: z.number().int().min(0).max(20).default(3),

    strategy: z.enum(BACKOFF_STRATEGIES).default('exponential'),

    /** Delay before the first retry, in milliseconds. */
    initialDelayMs: z.number().int().min(0).max(60_000).default(500),

    /**
     * Ceiling on any single delay.
     *
     * Exponential backoff from 500 ms doubles past an hour by attempt twelve. A cap keeps the
     * last attempt within a window somebody is still watching.
     */
    maxDelayMs: z
      .number()
      .int()
      .min(0)
      .max(60 * 60_000)
      .default(30_000),

    /** Multiplier for `exponential`. 2 doubles; 1.5 is gentler and often enough. */
    multiplier: z.number().min(1).max(10).default(2),

    /**
     * How much randomness to add to each delay.
     *
     * `full` picks uniformly in `[0, delay]`, `equal` in `[delay/2, delay]`, `none` disables it.
     * `full` spreads a thundering herd best and is the default; `equal` keeps a floor under the
     * delay, which matters when the downstream needs a minimum recovery time.
     */
    jitter: z.enum(JITTER_MODES).default('full'),

    /**
     * Ceiling on the whole operation, across every attempt.
     *
     * Distinct from a per-attempt timeout: an operation that retries four times with a 30 s
     * per-attempt timeout can occupy two minutes, and a caller waiting on it needs a bound on
     * the total rather than on each try.
     */
    totalTimeoutMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 60_000)
      .nullable()
      .default(null),

    /** Ceiling on one attempt. Null means the operation's own timeout applies. */
    attemptTimeoutMs: z
      .number()
      .int()
      .min(0)
      .max(10 * 60_000)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.maxDelayMs < policy.initialDelayMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxDelayMs'],
        message:
          'The delay ceiling is below the initial delay, so every retry would be capped to less ' +
          'than the first wait.',
      });
    }

    if (
      policy.totalTimeoutMs !== null &&
      policy.attemptTimeoutMs !== null &&
      policy.attemptTimeoutMs > policy.totalTimeoutMs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attemptTimeoutMs'],
        message:
          'One attempt may take longer than the whole operation is allowed, so the total ' +
          'timeout could never be reached.',
      });
    }
  });

export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** The defaults, parsed. Handy for a caller that wants to override one field. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = retryPolicySchema.parse({});

/**
 * Named policies for the four shapes that come up.
 *
 * Presets rather than a single default, because the right policy depends on who is waiting. A
 * user staring at a spinner and a webhook delivery to a third party are not the same problem,
 * and a framework that offered one number for both would be wrong for one of them.
 */
export const RETRY_PRESETS = {
  /**
   * Somebody is waiting. Two quick attempts and then an honest failure — a request that
   * retries for thirty seconds has already lost the user.
   */
  interactive: retryPolicySchema.parse({
    maxAttempts: 2,
    initialDelayMs: 100,
    maxDelayMs: 1_000,
    totalTimeoutMs: 5_000,
  }),

  /** Nobody is waiting. Patient, with a wide spread. */
  background: retryPolicySchema.parse({
    maxAttempts: 5,
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    totalTimeoutMs: 5 * 60_000,
  }),

  /**
   * Delivering to somebody else's server.
   *
   * The most patient preset, because the receiving end may be deploying, and a webhook that
   * gave up after ninety seconds would fail every deployment window. Spread over roughly an
   * hour.
   */
  webhook: retryPolicySchema.parse({
    maxAttempts: 8,
    initialDelayMs: 2_000,
    maxDelayMs: 15 * 60_000,
    multiplier: 3,
    totalTimeoutMs: null,
  }),

  /** A single attempt. Explicit, so "no retry" is a policy rather than an absent one. */
  none: retryPolicySchema.parse({ maxAttempts: 0 }),
} as const;

/**
 * The delay before a given attempt.
 *
 * `attempt` is 1-based and counts retries: attempt 1 is the first *retry*, after the initial
 * call failed.
 *
 * `random` is injectable so a test can assert the jitter bounds rather than asserting a value
 * it cannot predict — the alternative is a test that either disables jitter (and so does not
 * test it) or is flaky.
 */
export function backoffDelay(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  if (attempt < 1) return 0;

  const base = (() => {
    switch (policy.strategy) {
      case 'fixed':
        return policy.initialDelayMs;
      case 'linear':
        return policy.initialDelayMs * attempt;
      case 'exponential':
        return policy.initialDelayMs * policy.multiplier ** (attempt - 1);
    }
  })();

  // Capped before jitter, so the ceiling bounds the *result* rather than the input to a
  // randomiser that could then exceed it.
  const capped = Math.min(base, policy.maxDelayMs);

  switch (policy.jitter) {
    case 'none':
      return Math.round(capped);
    case 'equal':
      // Half fixed, half random. Keeps a floor under the delay for a downstream that needs a
      // minimum recovery window.
      return Math.round(capped / 2 + random() * (capped / 2));
    case 'full':
      // Uniform in [0, capped]. Spreads a herd best, at the cost of occasionally retrying
      // almost immediately.
      return Math.round(random() * capped);
  }
}

/** Every delay a policy would produce, for documentation and for the CLI. */
export function describeSchedule(policy: RetryPolicy): number[] {
  // Jitter off, so the schedule is the *shape* rather than one sample of it.
  const withoutJitter: RetryPolicy = { ...policy, jitter: 'none' };
  return Array.from({ length: policy.maxAttempts }, (_, index) =>
    backoffDelay(withoutJitter, index + 1),
  );
}

/**
 * Whether an error is worth retrying.
 *
 * Conservative by design: retry what is plausibly transient, give up on what is plausibly a
 * mistake. Retrying a 400 forever is a client bug that presents as a server problem, and a
 * dead-letter queue full of validation errors is a queue nobody reads.
 *
 * The rules, in order:
 *
 *   * An explicit `retryable` flag on the error wins. A caller who knows better says so.
 *   * `AbortError` is never retried — somebody cancelled deliberately.
 *   * A 4xx is not retried, **except** 408, 425 and 429, which mean "not now" rather than
 *     "not ever".
 *   * A 5xx is retried.
 *   * A network error — no status at all — is retried, because that is what a transient
 *     failure looks like from the client side.
 */
export function isRetryableError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return true;

  const candidate = error as {
    retryable?: boolean;
    name?: string;
    status?: number;
    statusCode?: number;
    code?: string;
  };

  if (typeof candidate.retryable === 'boolean') return candidate.retryable;

  // A deliberate cancellation. Retrying it would defeat the cancel.
  if (candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR') return false;

  const status = candidate.status ?? candidate.statusCode;
  if (typeof status === 'number') {
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 400 && status < 500) return false;
    return status >= 500;
  }

  /*
   * No status. Either a network failure or a programming error, and they are indistinguishable
   * here.
   *
   * Retrying is the right default: a network failure is the common case and is exactly what
   * retry is for, while a programming error fails identically on every attempt and is bounded
   * by `maxAttempts` anyway. The reverse default would make the framework give up on the
   * failure it exists to handle.
   */
  return true;
}

/** Statuses that mean "not now" rather than "not ever". Exported for documentation. */
export const RETRYABLE_CLIENT_STATUSES = [408, 425, 429] as const;
