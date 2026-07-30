import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitOpenError,
  describeSchedule,
  isRetryableError,
  RETRYABLE_CLIENT_STATUSES,
  RETRY_PRESETS,
  RetryExhaustedError,
  RetryTimeoutError,
  retryPolicySchema,
  withFallback,
  withRetry,
} from './index';

/**
 * Retry tests.
 *
 * Time is injected everywhere — `now`, `sleep` and `random` are all parameters — so nothing here
 * waits and nothing is flaky. A retry suite that actually slept would take a minute and would be
 * the first thing somebody skipped.
 */

const policy = (overrides: Record<string, unknown> = {}) => retryPolicySchema.parse(overrides);

/** A controllable clock and an instant sleep that records what it was asked to wait. */
function harness() {
  let clock = 0;
  const slept: number[] = [];

  return {
    now: () => clock,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// ===========================================================================
// Policy
// ===========================================================================

describe('the policy schema', () => {
  it('refuses a delay ceiling below the initial delay', () => {
    // Every retry would be capped below the first wait, which is not what anybody means.
    expect(() => policy({ initialDelayMs: 5_000, maxDelayMs: 1_000 })).toThrow();
  });

  it('refuses an attempt timeout longer than the total budget', () => {
    // The total could never be reached, so one of the two numbers is wrong.
    expect(() => policy({ totalTimeoutMs: 1_000, attemptTimeoutMs: 5_000 })).toThrow();
  });

  it('refuses an unknown key, so a typo is not silently ignored', () => {
    expect(() => policy({ maxRetries: 3 })).toThrow();
  });

  it('defaults jitter on', () => {
    // The single most consequential default in the package: without jitter, N clients that
    // failed together retry together.
    expect(policy().jitter).toBe('full');
  });
});

describe('backoff', () => {
  it('doubles by default', () => {
    const schedule = describeSchedule(policy({ maxAttempts: 5 }));
    expect(schedule).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
  });

  it('grows linearly when asked', () => {
    expect(describeSchedule(policy({ strategy: 'linear', maxAttempts: 4 }))).toEqual([
      500, 1_000, 1_500, 2_000,
    ]);
  });

  it('stays put for a fixed strategy', () => {
    expect(describeSchedule(policy({ strategy: 'fixed', maxAttempts: 3 }))).toEqual([
      500, 500, 500,
    ]);
  });

  it('caps every delay, so exponential growth does not reach hours', () => {
    const schedule = describeSchedule(policy({ maxAttempts: 12, maxDelayMs: 30_000 }));
    expect(Math.max(...schedule)).toBe(30_000);
  });

  it('applies the cap before jitter, so the ceiling bounds the result', () => {
    // Jitter applied to an uncapped value could exceed the ceiling, which would make the
    // ceiling a suggestion.
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const delay = backoffDelay(policy({ maxDelayMs: 1_000 }), attempt, () => 1);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });

  it('spreads full jitter across the whole range', () => {
    const wide = policy({ jitter: 'full', initialDelayMs: 1_000, strategy: 'fixed' });

    expect(backoffDelay(wide, 1, () => 0)).toBe(0);
    expect(backoffDelay(wide, 1, () => 1)).toBe(1_000);
    expect(backoffDelay(wide, 1, () => 0.5)).toBe(500);
  });

  it('keeps a floor under equal jitter', () => {
    // For a downstream that needs a minimum recovery window, `full` occasionally retrying
    // almost immediately is wrong.
    const equal = policy({ jitter: 'equal', initialDelayMs: 1_000, strategy: 'fixed' });

    expect(backoffDelay(equal, 1, () => 0)).toBe(500);
    expect(backoffDelay(equal, 1, () => 1)).toBe(1_000);
  });
});

describe('the presets', () => {
  it('give an interactive caller a short total budget', () => {
    // A request that retries for thirty seconds has already lost the user.
    expect(RETRY_PRESETS.interactive.totalTimeoutMs).toBeLessThanOrEqual(5_000);
  });

  it('let a webhook keep trying across a deployment window', () => {
    // The receiving end may be deploying. A webhook that gave up after ninety seconds would
    // fail every deployment.
    const total = describeSchedule(RETRY_PRESETS.webhook).reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(20 * 60_000);
    expect(RETRY_PRESETS.webhook.totalTimeoutMs).toBe(null);
  });

  it('make "no retry" an explicit policy rather than an absent one', () => {
    expect(RETRY_PRESETS.none.maxAttempts).toBe(0);
  });
});

// ===========================================================================
// Classification
// ===========================================================================

describe('classifying an error', () => {
  it('retries a 5xx and a network failure', () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
  });

  it('does not retry a 4xx', () => {
    // Retrying a 400 forever is a client bug that presents as a server problem, and a dead-letter
    // queue full of validation errors is a queue nobody reads.
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 403 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  it('retries the 4xx statuses that mean "not now"', () => {
    for (const status of RETRYABLE_CLIENT_STATUSES) {
      expect(isRetryableError({ status }), String(status)).toBe(true);
    }
  });

  it('never retries a deliberate cancellation', () => {
    const aborted = new Error('cancelled');
    aborted.name = 'AbortError';

    // Retrying it would defeat the cancel.
    expect(isRetryableError(aborted)).toBe(false);
    expect(isRetryableError({ code: 'ABORT_ERR' })).toBe(false);
  });

  it('lets an explicit flag win', () => {
    expect(isRetryableError({ status: 400, retryable: true })).toBe(true);
    expect(isRetryableError({ status: 500, retryable: false })).toBe(false);
  });

  it('reads either status field, because clients disagree', () => {
    expect(isRetryableError({ statusCode: 502 })).toBe(true);
    expect(isRetryableError({ statusCode: 401 })).toBe(false);
  });
});

// ===========================================================================
// Execution
// ===========================================================================

describe('withRetry', () => {
  it('returns on the first success without sleeping', async () => {
    const clock = harness();
    const outcome = await withRetry(async () => 'ok', {
      operation: 'test',
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(outcome).toMatchObject({ value: 'ok', attempts: 1 });
    expect(clock.slept).toEqual([]);
  });

  it('retries a transient failure and then succeeds', async () => {
    const clock = harness();
    let calls = 0;

    const outcome = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('flaky'), { status: 503 });
        return 'recovered';
      },
      {
        operation: 'test',
        policy: policy({ jitter: 'none' }),
        sleep: clock.sleep,
        now: clock.now,
      },
    );

    expect(outcome).toMatchObject({ value: 'recovered', attempts: 3 });
    expect(clock.slept).toEqual([500, 1_000]);
  });

  it('fails immediately on a non-retryable error, with the original error', async () => {
    const clock = harness();
    const badRequest = Object.assign(new Error('name is required'), { status: 400 });
    const operation = vi.fn(async () => {
      throw badRequest;
    });

    // The original error, not a wrapper. Telling a caller "retry exhausted" about their own bad
    // request tells them the wrong thing.
    await expect(
      withRetry(operation, { operation: 'test', sleep: clock.sleep, now: clock.now }),
    ).rejects.toBe(badRequest);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(clock.slept).toEqual([]);
  });

  it('throws RetryExhaustedError carrying the original error as the cause', async () => {
    const clock = harness();
    const downstream = Object.assign(new Error('upstream exploded'), { status: 500 });

    const error = await withRetry(
      async () => {
        throw downstream;
      },
      {
        operation: 'sync-pull',
        policy: policy({ maxAttempts: 2 }),
        sleep: clock.sleep,
        now: clock.now,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryExhaustedError);
    // The message an operator needs is the downstream's, not the framework's.
    expect((error as Error).message).toContain('upstream exploded');
    expect((error as Error).message).toContain('sync-pull');
    expect((error as RetryExhaustedError).cause).toBe(downstream);
    expect((error as RetryExhaustedError).context.attempts).toHaveLength(3);
  });

  it('does not sleep after the final attempt', async () => {
    const clock = harness();

    await withRetry(
      async () => {
        throw Object.assign(new Error('boom'), { status: 500 });
      },
      {
        operation: 'test',
        policy: policy({ maxAttempts: 2, jitter: 'none' }),
        sleep: clock.sleep,
        now: clock.now,
      },
    ).catch(() => undefined);

    // Two waits for three attempts. Waiting to then give up is time spent on nothing.
    expect(clock.slept).toHaveLength(2);
  });

  it('gives up when the total budget would be exceeded by the next wait', async () => {
    const clock = harness();

    const error = await withRetry(
      async () => {
        throw Object.assign(new Error('slow'), { status: 500 });
      },
      {
        operation: 'test',
        policy: policy({
          maxAttempts: 10,
          initialDelayMs: 1_000,
          jitter: 'none',
          totalTimeoutMs: 2_500,
        }),
        sleep: clock.sleep,
        now: clock.now,
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryTimeoutError);
    // Checked *before* sleeping, so it does not wait out a delay it has no time to use.
    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(2_500);
  });

  it('reports each retry to an observer', async () => {
    const clock = harness();
    const seen: number[] = [];

    await withRetry(
      async () => {
        throw Object.assign(new Error('boom'), { status: 500 });
      },
      {
        operation: 'test',
        policy: policy({ maxAttempts: 2, jitter: 'none' }),
        sleep: clock.sleep,
        now: clock.now,
        onRetry: (attempt) => seen.push(attempt.attempt),
      },
    ).catch(() => undefined);

    expect(seen).toEqual([1, 2]);
  });

  it('does not let a throwing observer turn a retryable failure into a permanent one', async () => {
    const clock = harness();
    let calls = 0;

    const outcome = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw Object.assign(new Error('flaky'), { status: 500 });
        return 'ok';
      },
      {
        operation: 'test',
        policy: policy({ jitter: 'none' }),
        sleep: clock.sleep,
        now: clock.now,
        onRetry: () => {
          throw new Error('the metrics backend is down');
        },
      },
    );

    // A lost metric must not cost a successful operation.
    expect(outcome.value).toBe('ok');
  });

  it('honours a caller abort without wrapping it', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await withRetry(async () => 'never', {
      operation: 'test',
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    // The caller asked for this and needs to recognise their own abort.
    expect((error as Error).name).toBe('AbortError');
  });

  it('times out a single attempt and retries it', async () => {
    let calls = 0;

    const outcome = await withRetry(
      async (_attempt, signal) => {
        calls += 1;
        if (calls === 1) {
          // Never settles on its own; only the attempt timeout ends it.
          return new Promise<string>((resolve) => {
            signal?.addEventListener('abort', () => resolve('unused'), { once: true });
          });
        }
        return 'second attempt';
      },
      {
        operation: 'test',
        policy: policy({ maxAttempts: 2, attemptTimeoutMs: 20, initialDelayMs: 1, jitter: 'none' }),
      },
    );

    expect(outcome.value).toBe('second attempt');
    expect(calls).toBe(2);
  });

  it('passes an abort signal into the attempt, so a timeout can actually stop the work', async () => {
    let sawSignal = false;

    await withRetry(
      async (_attempt, signal) => {
        sawSignal = signal !== undefined;
        return 'ok';
      },
      { operation: 'test', policy: policy({ attemptTimeoutMs: 1_000 }) },
    );

    // A `Promise.race` alone would leave the operation running — for an HTTP call, a connection
    // nobody is reading.
    expect(sawSignal).toBe(true);
  });
});

describe('withFallback', () => {
  it('returns the primary when it works', async () => {
    const result = await withFallback(
      async () => 'primary',
      () => 'fallback',
    );
    expect(result).toMatchObject({ value: 'primary', used: 'primary' });
  });

  it('falls back and reports that it did', async () => {
    const result = await withFallback(
      async () => {
        throw new Error('down');
      },
      () => 'cached',
    );

    // `used` is in the result so a caller can record it. Falling back silently would hide a
    // downstream that has been down for a week.
    expect(result).toMatchObject({ value: 'cached', used: 'fallback' });
    expect((result.error as Error).message).toBe('down');
  });

  it('does not fall back on a deliberate cancellation', async () => {
    const aborted = Object.assign(new Error('cancelled'), { name: 'AbortError' });

    await expect(
      withFallback(
        async () => {
          throw aborted;
        },
        () => 'fallback',
      ),
    ).rejects.toBe(aborted);
  });
});

// ===========================================================================
// Circuit breaker
// ===========================================================================

describe('the circuit breaker', () => {
  function build(overrides: Record<string, unknown> = {}) {
    let clock = 0;
    const changes: Array<{ from: string; to: string }> = [];

    const breaker = new CircuitBreaker({
      name: 'downstream',
      policy: {
        failureThreshold: 3,
        successThreshold: 2,
        openDurationMs: 1_000,
        windowMs: 10_000,
        ...overrides,
      },
      now: () => clock,
      onStateChange: (change) => changes.push({ from: change.from, to: change.to }),
    });

    return { breaker, changes, advance: (ms: number) => (clock += ms) };
  }

  const fail = () => Promise.reject(Object.assign(new Error('down'), { status: 500 }));

  it('stays closed while calls succeed', async () => {
    const { breaker } = build();
    await breaker.execute(async () => 'ok');
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('opens after consecutive failures', async () => {
    const { breaker, changes } = build();

    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    expect(breaker.snapshot().state).toBe('open');
    expect(changes).toContainEqual({ from: 'closed', to: 'open' });
  });

  it('refuses without calling the downstream once open', async () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    const operation = vi.fn(async () => 'ok');
    await expect(breaker.execute(operation)).rejects.toBeInstanceOf(CircuitOpenError);

    // The value of a breaker is the call it does *not* make.
    expect(operation).not.toHaveBeenCalled();
    expect(breaker.snapshot().totals.rejections).toBe(1);
  });

  it('clears the count on a success, because the threshold means consecutive', async () => {
    const { breaker } = build();

    await breaker.execute(fail).catch(() => undefined);
    await breaker.execute(fail).catch(() => undefined);
    await breaker.execute(async () => 'ok');
    await breaker.execute(fail).catch(() => undefined);

    // An error rate of one in ten is not a downstream that needs protecting from.
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('forgets failures outside the window', async () => {
    const { breaker, advance } = build({ windowMs: 1_000 });

    await breaker.execute(fail).catch(() => undefined);
    await breaker.execute(fail).catch(() => undefined);
    advance(2_000);
    await breaker.execute(fail).catch(() => undefined);

    // Three failures spread over a week is a normal error rate, not an outage.
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('half-opens once the window elapses, and closes after enough probes succeed', async () => {
    const { breaker, advance, changes } = build();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    advance(1_500);
    expect(breaker.snapshot().state).toBe('half_open');

    await breaker.execute(async () => 'ok');
    expect(breaker.snapshot().state).toBe('half_open');

    await breaker.execute(async () => 'ok');
    expect(breaker.snapshot().state).toBe('closed');
    expect(changes.at(-1)).toEqual({ from: 'half_open', to: 'closed' });
  });

  it('re-opens when a probe fails', async () => {
    const { breaker, advance } = build();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    advance(1_500);
    await breaker.execute(fail).catch(() => undefined);

    expect(breaker.snapshot().state).toBe('open');
  });

  it('allows exactly one probe at a time in half_open', async () => {
    const { breaker, advance } = build();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);
    advance(1_500);

    /*
     * The property that stops the breaker flapping.
     *
     * Without it, every concurrent caller becomes a probe the moment the window elapses — the
     * full load hits a downstream that has just come back, and the breaker re-opens. That cycle
     * can run for hours.
     */
    let release: (value: string) => void = () => undefined;
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });

    const probe = breaker.execute(() => held);
    const second = breaker.execute(async () => 'ok');

    await expect(second).rejects.toBeInstanceOf(CircuitOpenError);

    release('ok');
    await probe;
  });

  it('does not count an error the caller says is not a failure', async () => {
    const clock = 0;
    const breaker = new CircuitBreaker({
      name: 'x',
      policy: { failureThreshold: 2, successThreshold: 1, openDurationMs: 1_000, windowMs: 10_000 },
      now: () => clock,
      // A 404 from a downstream is an answer, not an outage.
      isFailure: (error) => (error as { status?: number }).status !== 404,
    });

    for (let i = 0; i < 5; i += 1) {
      await breaker
        .execute(async () => {
          throw Object.assign(new Error('missing'), { status: 404 });
        })
        .catch(() => undefined);
    }

    expect(breaker.snapshot().state).toBe('closed');
    void clock;
  });

  it('reports the state as half_open on read once the window elapses', async () => {
    const { breaker, advance } = build();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    advance(1_500);
    // Refreshed on read, so a dashboard does not show a stale `open` that only updates on the
    // next call.
    expect(breaker.snapshot().state).toBe('half_open');
  });

  it('can be reset and tripped by an operator', async () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    breaker.reset();
    expect(breaker.snapshot().state).toBe('closed');

    breaker.trip('taking the provider out of rotation');
    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.snapshot().lastError).toContain('out of rotation');
  });

  it('is not retryable, so a retry loop does not spin against an open circuit', async () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i += 1) await breaker.execute(fail).catch(() => undefined);

    const error = await breaker.execute(async () => 'ok').catch((caught: unknown) => caught);
    expect(isRetryableError(error)).toBe(false);
  });
});

describe('the breaker registry', () => {
  it('keeps one breaker per downstream, so one outage does not stop the others', async () => {
    const registry = new CircuitBreakerRegistry({
      failureThreshold: 1,
      successThreshold: 1,
      openDurationMs: 1_000,
      windowMs: 10_000,
    });

    await registry
      .get('provider-a')
      .execute(async () => {
        throw new Error('down');
      })
      .catch(() => undefined);

    expect(registry.get('provider-a').snapshot().state).toBe('open');
    // A shared breaker would turn a single provider outage into a total one.
    expect(registry.get('provider-b').snapshot().state).toBe('closed');
  });

  it('returns the same instance for a name', () => {
    const registry = new CircuitBreakerRegistry();
    expect(registry.get('a')).toBe(registry.get('a'));
  });

  it('lists only the breakers that are not closed', async () => {
    const registry = new CircuitBreakerRegistry({
      failureThreshold: 1,
      successThreshold: 1,
      openDurationMs: 1_000,
      windowMs: 10_000,
    });

    await registry
      .get('bad')
      .execute(async () => {
        throw new Error('down');
      })
      .catch(() => undefined);
    registry.get('good');

    // The list an operator actually wants.
    expect(registry.unhealthy().map((entry) => entry.name)).toEqual(['bad']);
    expect(registry.snapshot()).toHaveLength(2);
  });
});
