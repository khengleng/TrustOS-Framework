import { describe, expect, it } from 'vitest';
import { serviceSchema, runbookSchema, ServiceRegistry } from '@trustsystem/sre-core';
import {
  assertPostureSound,
  degradationPlan,
  dependencyResilienceSchema,
  fallbackSchema,
  reviewPosture,
  servicePostureSchema,
  worstCaseLatencyMs,
} from './index';

function fallback(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'fail_fast',
    description: 'Payments are refused with a 503 rather than accepted without a ledger entry.',
    businessImpact: 'Merchants cannot accept payments while the ledger is unavailable.',
    approvedBy: 'usr_product',
    ...overrides,
  };
}

function declaration(overrides: Record<string, unknown> = {}) {
  return dependencyResilienceSchema.parse({
    dependencyId: 'ledger',
    kind: 'api',
    timeoutMs: 1_000,
    totalBudgetMs: 3_000,
    retry: null,
    circuitBreaker: {},
    fallback: fallback(),
    ...overrides,
  });
}

function posture(overrides: Record<string, unknown> = {}) {
  return servicePostureSchema.parse({
    serviceId: 'payments.api',
    callerTimeoutMs: 5_000,
    dependencies: [declaration()],
    reviewedAt: '2026-05-01T00:00:00.000Z',
    reviewedBy: 'usr_platform',
    ...overrides,
  });
}

const runbook = runbookSchema.parse({
  runbookId: 'rb.outage',
  title: 'Dependency outage',
  trigger: 'A critical dependency is unavailable for more than two minutes.',
  severityHint: 'SEV2',
  steps: [
    { title: 'Confirm', action: 'Probe the dependency from a second service.', verification: null },
  ],
  escalateTo: 'Platform on-call.',
  lastReviewedAt: '2026-05-01T00:00:00.000Z',
  ownerId: 'usr_platform',
});

function service(overrides: Record<string, unknown> = {}) {
  return serviceSchema.parse({
    serviceId: 'payments.api',
    name: 'Payments API',
    description: 'Accepts payment requests and posts them to the ledger.',
    tier: 'tier_1',
    ownerTeam: 'payments',
    onCallRotation: 'payments-primary',
    runbookIds: ['rb.outage'],
    environment: 'production',
    registeredAt: '2026-01-01T00:00:00.000Z',
    dependencies: [
      {
        dependencyId: 'ledger',
        kind: 'api',
        description: 'Posts a journal entry for every accepted payment.',
        critical: true,
        targetServiceId: null,
        degradedBehaviour: 'Payments are refused rather than accepted un-posted.',
        runbookId: 'rb.outage',
      },
    ],
    ...overrides,
  });
}

describe('declaring a fallback', () => {
  it('refuses a stale-serving fallback the caller cannot detect', () => {
    /*
     * The worst combination available here: the service reports healthy, the indicator counts a
     * success, and a stale answer reaches a customer who has no way to know.
     */
    expect(() =>
      fallbackSchema.parse(fallback({ mode: 'serve_stale', maxStalenessSeconds: 60 })),
    ).toThrow(/how the caller can tell/);
  });

  it('refuses unbounded staleness', () => {
    expect(() =>
      fallbackSchema.parse(
        fallback({ mode: 'serve_stale', visibleTo: 'X-TrustOS-Stale response header.' }),
      ),
    ).toThrow(/how old an answer may be/);
  });

  it('refuses queueing with nowhere durable to queue', () => {
    // A queue that does not survive a restart loses the requests it accepted.
    expect(() =>
      fallbackSchema.parse(
        fallback({
          mode: 'queue_for_later',
          visibleTo: 'A 202 with a status URL the caller polls.',
        }),
      ),
    ).toThrow(/survives a restart/);
  });

  it('accepts fail_fast without a visibility mechanism', () => {
    // An error is already visible; that is its virtue.
    expect(fallbackSchema.parse(fallback()).visibleTo).toBeNull();
  });

  it('accepts a complete stale declaration', () => {
    const parsed = fallbackSchema.parse(
      fallback({
        mode: 'serve_stale',
        visibleTo: 'X-TrustOS-Stale response header carrying the age in seconds.',
        maxStalenessSeconds: 300,
      }),
    );

    expect(parsed.maxStalenessSeconds).toBe(300);
  });
});

describe('declaring a retry', () => {
  it('refuses a retry with no stated reason it is safe to repeat', () => {
    // A retry on a non-idempotent write is a duplicate payment, and it is one line of config away.
    expect(() => declaration({ retry: {} })).toThrow(/safe to repeat/);
  });

  it('accepts one that states the mechanism', () => {
    const parsed = declaration({
      retry: {},
      retrySafety: 'Every posting carries the payment reference as its idempotency key.',
    });

    expect(parsed.retry?.maxAttempts).toBe(3);
  });

  it('refuses a budget smaller than one call', () => {
    expect(() => declaration({ totalBudgetMs: 500 })).toThrow(/at least one call/);
  });
});

describe('worst case latency', () => {
  it('is the timeout when there is no retry', () => {
    expect(worstCaseLatencyMs(declaration())).toBe(1_000);
  });

  it('counts the first call as well as the retries', () => {
    /*
     * `maxAttempts: 3` in @trustsystem/retry is three retries — four calls and three waits. The
     * off-by-one is how a budget check passes while the caller still times out.
     */
    const withRetry = declaration({
      retry: { maxAttempts: 3, initialDelayMs: 500, multiplier: 2, jitter: 'none' },
      retrySafety: 'Every posting carries the payment reference as its idempotency key.',
    });

    // 4 × 1000ms of calls, plus 500 + 1000 + 2000 of backoff.
    expect(worstCaseLatencyMs(withRetry)).toBe(7_500);
  });

  it('honours the delay ceiling', () => {
    const capped = declaration({
      retry: {
        maxAttempts: 5,
        initialDelayMs: 1_000,
        maxDelayMs: 2_000,
        multiplier: 2,
        jitter: 'none',
      },
      retrySafety: 'Every posting carries the payment reference as its idempotency key.',
    });

    // Backoffs cap at 2000: 1000 + 2000 + 2000 + 2000 + 2000.
    expect(worstCaseLatencyMs(capped)).toBe(1_000 * 6 + 9_000);
  });
});

describe('reviewing a posture', () => {
  it('passes a sound one', () => {
    expect(reviewPosture({ posture: posture(), service: service() }).sound).toBe(true);
  });

  it('finds a retry schedule that outlasts the caller', () => {
    /*
     * The finding worth having. Three retries behind a two-second caller timeout means the caller
     * has given up long before the last attempt, so the retries cost capacity and buy nothing —
     * and each looks reasonable read alone.
     */
    const findings = reviewPosture({
      posture: posture({
        callerTimeoutMs: 2_000,
        dependencies: [
          declaration({
            totalBudgetMs: 20_000,
            retry: { maxAttempts: 3, initialDelayMs: 500, jitter: 'none' },
            retrySafety: 'Every posting carries the payment reference as its idempotency key.',
          }),
        ],
      }),
    }).findings;

    expect(findings[0]?.kind).toBe('budget_exceeds_caller_timeout');
    expect(findings[0]?.severity).toBe('high');
  });

  it('finds a retry with no breaker behind it', () => {
    // Retry alone multiplies load on something already failing, so it never gets a moment to recover.
    const findings = reviewPosture({
      posture: posture({
        callerTimeoutMs: 30_000,
        dependencies: [
          declaration({
            totalBudgetMs: 20_000,
            circuitBreaker: null,
            retry: { maxAttempts: 2, initialDelayMs: 200, jitter: 'none' },
            retrySafety: 'Every posting carries the payment reference as its idempotency key.',
          }),
        ],
      }),
    }).findings;

    expect(findings.some((finding) => finding.kind === 'retry_without_breaker')).toBe(true);
  });

  it('finds a dependency the service has and the posture does not', () => {
    /*
     * The state a posture drifts into. A dependency gets added in code, nobody updates the
     * posture, and what happens when it fails is decided during the outage.
     */
    const findings = reviewPosture({
      posture: posture({ dependencies: [] }),
      service: service(),
    }).findings;

    expect(findings[0]?.kind).toBe('undeclared_dependency');
    expect(findings[0]?.severity).toBe('high');
  });

  it('refuses to deploy behind a posture with high-severity findings', () => {
    expect(() =>
      assertPostureSound({ posture: posture({ dependencies: [] }), service: service() }),
    ).toThrow(/high-severity/);
  });

  it('is silent on a posture without a service to compare against', () => {
    // A posture can be reviewed before the service is registered; it just checks less.
    expect(() => assertPostureSound({ posture: posture() })).not.toThrow();
  });
});

describe('the degradation plan', () => {
  it('answers what happens now from what was decided then', () => {
    /*
     * The point of the whole package: the answer to "what happens when the ledger is down" is the
     * same at 3am as it was at the design review, and it is written down.
     */
    const plan = degradationPlan({
      posture: posture({
        dependencies: [
          declaration({
            fallback: fallback({
              mode: 'serve_stale',
              visibleTo: 'X-TrustOS-Stale header carrying the age in seconds.',
              maxStalenessSeconds: 300,
            }),
          }),
        ],
      }),
      unavailableDependencyIds: ['ledger'],
    });

    expect(plan[0]?.mode).toBe('serve_stale');
    expect(plan[0]?.visibleTo).toContain('X-TrustOS-Stale');
  });

  it('says nothing about dependencies that are up', () => {
    expect(degradationPlan({ posture: posture(), unavailableDependencyIds: [] })).toHaveLength(0);
  });
});

describe('with the registry', () => {
  it('checks a posture against the registered service', () => {
    const registry = new ServiceRegistry({ runbooks: [runbook], services: [service()] });
    const result = reviewPosture({ posture: posture(), service: registry.require('payments.api') });

    expect(result.sound).toBe(true);
  });
});
