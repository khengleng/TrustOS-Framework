import { z } from 'zod';
import { ApiError } from '@trustos/errors';

/**
 * A circuit breaker.
 *
 * Retry alone makes a struggling downstream worse: every caller keeps hammering it, and the
 * thing that needed a moment to recover never gets one. A breaker is the other half — after
 * enough failures it stops calling at all, waits, and then lets a single request through to
 * find out whether the downstream came back.
 *
 * Three states, and the middle one is the whole point:
 *
 *   closed     calls pass through. Failures are counted.
 *   open       calls are refused immediately, without touching the downstream.
 *   half_open  exactly one probe is allowed. Success closes; failure re-opens.
 *
 * `half_open` allowing *one* probe rather than resuming normal traffic is what stops the
 * breaker flapping: resuming everything at once re-overwhelms a downstream that has only just
 * come back, which re-opens the breaker, which is a cycle that can run for hours.
 */

export const CIRCUIT_STATES = ['closed', 'open', 'half_open'] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

export const circuitBreakerPolicySchema = z
  .object({
    /** Consecutive failures that open the circuit. */
    failureThreshold: z.number().int().min(1).max(100).default(5),

    /**
     * Successes in `half_open` that close it again.
     *
     * More than one is defensible for a downstream that fails intermittently: a single lucky
     * probe would close the circuit and send the full load back at something still broken.
     */
    successThreshold: z.number().int().min(1).max(20).default(2),

    /** How long the circuit stays open before allowing a probe. */
    openDurationMs: z
      .number()
      .int()
      .min(100)
      .max(60 * 60_000)
      .default(30_000),

    /**
     * Window for counting failures, in milliseconds.
     *
     * Without a window, five failures spread over a week would open the circuit — which is not
     * a struggling downstream, it is a normal error rate. The window makes the threshold mean
     * "five failures *recently*".
     */
    windowMs: z
      .number()
      .int()
      .min(1_000)
      .max(60 * 60_000)
      .default(60_000),
  })
  .strict();

export type CircuitBreakerPolicy = z.infer<typeof circuitBreakerPolicySchema>;

export const DEFAULT_CIRCUIT_POLICY: CircuitBreakerPolicy = circuitBreakerPolicySchema.parse({});

export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  successes: number;
  /** When the circuit last opened. Null when it has never opened. */
  openedAt: Date | null;
  /** When a probe will next be allowed. Null unless open. */
  retryAt: Date | null;
  lastError: string | null;
  /** Totals since construction, for a dashboard. */
  totals: { calls: number; failures: number; rejections: number };
}

/**
 * Thrown when the circuit is open.
 *
 * Distinguished from a downstream failure on purpose: this call never reached the downstream,
 * and an operator reading "circuit open" knows to look at what opened it rather than at this
 * request.
 */
export class CircuitOpenError extends Error {
  readonly circuit: string;
  readonly retryAt: Date;

  constructor(circuit: string, retryAt: Date) {
    super(
      `The circuit "${circuit}" is open and will not call the downstream until ` +
        `${retryAt.toISOString()}.`,
    );
    this.name = 'CircuitOpenError';
    this.circuit = circuit;
    this.retryAt = retryAt;
    // Not retryable by the retry loop. Retrying against an open circuit is spinning on a
    // decision that has already been made; the caller should back off or degrade.
    (this as unknown as { retryable: boolean }).retryable = false;
  }
}

export interface CircuitBreakerOptions {
  name: string;
  policy?: CircuitBreakerPolicy;
  /** Notified on every state change. For a metric or an alert. Must not throw. */
  onStateChange?: (change: {
    from: CircuitState;
    to: CircuitState;
    snapshot: CircuitSnapshot;
  }) => void;
  now?: () => number;
  /** Decides whether an error counts against the breaker. */
  isFailure?: (error: unknown) => boolean;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAtMs: number | null = null;
  private firstFailureMs: number | null = null;
  private lastError: string | null = null;
  private probeInFlight = false;

  private readonly totals = { calls: 0, failures: 0, rejections: 0 };
  private readonly policy: CircuitBreakerPolicy;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.policy = options.policy ?? DEFAULT_CIRCUIT_POLICY;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Runs an operation through the breaker.
   *
   * Throws `CircuitOpenError` without calling the operation when the circuit is open — which is
   * the point: the value of a breaker is the call it does *not* make.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.refresh();

    if (this.state === 'open') {
      this.totals.rejections += 1;
      throw new CircuitOpenError(this.options.name, this.nextRetryAt() as Date);
    }

    /*
     * In `half_open`, exactly one probe at a time.
     *
     * Without this, every concurrent caller becomes a probe the moment the window elapses — the
     * full load hits a downstream that has just come back, and the breaker re-opens. Extra
     * callers are refused as though the circuit were still open, which it effectively is for
     * them.
     */
    if (this.state === 'half_open' && this.probeInFlight) {
      this.totals.rejections += 1;
      throw new CircuitOpenError(this.options.name, this.nextRetryAt() ?? new Date(this.now()));
    }

    if (this.state === 'half_open') this.probeInFlight = true;
    this.totals.calls += 1;

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      const counts = this.options.isFailure ? this.options.isFailure(error) : true;
      if (counts) this.recordFailure(error);
      throw error;
    } finally {
      if (this.state === 'half_open') this.probeInFlight = false;
    }
  }

  private recordSuccess(): void {
    this.lastError = null;

    if (this.state === 'half_open') {
      this.successes += 1;
      if (this.successes >= this.policy.successThreshold) this.transition('closed');
      return;
    }

    // A success in `closed` clears the count. The threshold means *consecutive* failures: an
    // error rate of one in ten is not a downstream that needs protecting from.
    this.failures = 0;
    this.firstFailureMs = null;
  }

  private recordFailure(error: unknown): void {
    this.totals.failures += 1;
    this.lastError =
      error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);

    if (this.state === 'half_open') {
      // The probe failed. Back to open, and the clock restarts.
      this.transition('open');
      return;
    }

    const nowMs = this.now();

    // Outside the window, the count starts again — five failures spread over a week is a normal
    // error rate rather than an outage.
    if (this.firstFailureMs !== null && nowMs - this.firstFailureMs > this.policy.windowMs) {
      this.failures = 0;
      this.firstFailureMs = null;
    }

    if (this.firstFailureMs === null) this.firstFailureMs = nowMs;
    this.failures += 1;

    if (this.failures >= this.policy.failureThreshold) this.transition('open');
  }

  /** Moves `open` to `half_open` once the window has elapsed. */
  private refresh(): void {
    if (this.state !== 'open' || this.openedAtMs === null) return;
    if (this.now() - this.openedAtMs < this.policy.openDurationMs) return;
    this.transition('half_open');
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;

    this.state = to;

    if (to === 'open') {
      this.openedAtMs = this.now();
      this.successes = 0;
      this.probeInFlight = false;
    }
    if (to === 'half_open') {
      this.successes = 0;
      this.probeInFlight = false;
    }
    if (to === 'closed') {
      this.failures = 0;
      this.successes = 0;
      this.openedAtMs = null;
      this.firstFailureMs = null;
    }

    // Isolated: an observer that threw would leave the breaker mid-transition, which is worse
    // than a lost metric.
    try {
      this.options.onStateChange?.({ from, to, snapshot: this.snapshot() });
    } catch {
      /* ignored deliberately; see above */
    }
  }

  private nextRetryAt(): Date | null {
    if (this.openedAtMs === null) return null;
    return new Date(this.openedAtMs + this.policy.openDurationMs);
  }

  snapshot(): CircuitSnapshot {
    // Refreshed first, so a reader sees `half_open` once the window has elapsed rather than a
    // stale `open` that only updates on the next call.
    this.refresh();

    return {
      name: this.options.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      openedAt: this.openedAtMs === null ? null : new Date(this.openedAtMs),
      retryAt: this.state === 'open' ? this.nextRetryAt() : null,
      lastError: this.lastError,
      totals: { ...this.totals },
    };
  }

  /**
   * Forces the circuit closed.
   *
   * For an operator who has fixed the downstream and does not want to wait out the window. It
   * is deliberately not called anywhere automatically — a breaker that reset itself on a
   * schedule would be a breaker with a longer window.
   */
  reset(): void {
    this.transition('closed');
  }

  /** Forces it open. For taking a downstream out of rotation deliberately. */
  trip(reason: string): void {
    this.lastError = reason;
    this.transition('open');
  }
}

/**
 * A registry of breakers, one per named downstream.
 *
 * Per-downstream rather than global, because one failing provider must not stop calls to a
 * healthy one — a shared breaker turns a single provider outage into a total one.
 */
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly defaults: CircuitBreakerPolicy = DEFAULT_CIRCUIT_POLICY,
    private readonly onStateChange?: CircuitBreakerOptions['onStateChange'],
  ) {}

  get(name: string, policy?: CircuitBreakerPolicy): CircuitBreaker {
    const existing = this.breakers.get(name);
    if (existing) return existing;

    const breaker = new CircuitBreaker({
      name,
      policy: policy ?? this.defaults,
      ...(this.onStateChange ? { onStateChange: this.onStateChange } : {}),
    });
    this.breakers.set(name, breaker);
    return breaker;
  }

  /** Every breaker's state. Rendered by the integration dashboard. */
  snapshot(): CircuitSnapshot[] {
    return [...this.breakers.values()].map((breaker) => breaker.snapshot());
  }

  /** Breakers that are not closed. The list an operator actually wants. */
  unhealthy(): CircuitSnapshot[] {
    return this.snapshot().filter((entry) => entry.state !== 'closed');
  }
}

/** Wraps a circuit refusal as an `ApiError`, for a caller that surfaces it over HTTP. */
export function circuitToApiError(error: CircuitOpenError): ApiError {
  return ApiError.rateLimited(
    'This integration is temporarily unavailable while a downstream recovers.',
    {
      reason: 'circuit_open',
      circuit: error.circuit,
      retryAfterSeconds: Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1000)),
    },
  );
}
