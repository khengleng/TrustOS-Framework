/**
 * @trustos/retry
 *
 * Retry policies, execution, and circuit breaking. Every integration in phase 6 retries
 * something, and they all use this — retry is where well-meaning code causes outages, and one
 * implementation is easier to get right than six.
 *
 * Three decisions are worth knowing before changing anything here, and each is documented at
 * its definition:
 *
 *   * **Jitter is on by default.** Without it, N clients that failed together retry together,
 *     and the retry storm is worse than the original failure.
 *   * **Not every error is retryable.** A 4xx fails immediately, except 408, 425 and 429.
 *   * **A breaker's `half_open` allows exactly one probe.** Resuming full traffic at once
 *     re-overwhelms a downstream that has just recovered, which is a cycle that runs for hours.
 */
export * from './policy';
export * from './execute';
export * from './circuit-breaker';
