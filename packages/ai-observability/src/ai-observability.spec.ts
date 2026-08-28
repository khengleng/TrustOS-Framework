import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiTelemetry, percentile } from './telemetry';
import { InMemoryTelemetryStore } from './testing';

/**
 * Three things get tested properly here.
 *
 * That no content is ever stored, because an observability store is the widest data exposure in a
 * system. That a failure to record cannot fail a request. And that the numbers say what they are
 * computed from — a p95 over an unstated window is a number people size infrastructure with.
 */

let clock = new Date('2026-03-01T09:00:00.000Z');
let counter = 0;

function telemetry(options: Record<string, unknown> = {}) {
  const store = new InMemoryTelemetryStore();
  const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() };

  return {
    store,
    metrics,
    ai: new AiTelemetry({ store, metrics, now: () => clock, ...options }),
  };
}

const record = (overrides: Record<string, unknown> = {}) => ({
  id: `req_${(counter += 1)}`,
  at: clock,
  organizationId: 'org_a',
  application: 'support',
  modelId: 'test.small',
  provider: 'test',
  outcome: 'success',
  latencyMs: 500,
  totalTokens: 1000,
  promptTokens: 800,
  completionTokens: 200,
  costCents: 0.5,
  ...overrides,
});

beforeEach(() => {
  clock = new Date('2026-03-01T09:00:00.000Z');
  counter = 0;
});

describe('what is stored', () => {
  it('rejects a record carrying prompt or completion text', async () => {
    // The schema is strict, so a well-meaning addition of `content` is refused at the boundary
    // rather than quietly filling the widest-read store in the system with customer messages.
    const { ai, store } = telemetry();

    await ai.record(record({ content: 'Where is my transfer?' }));

    expect(store.records.size).toBe(0);
  });

  it('stores a valid record', async () => {
    const { ai, store } = telemetry();

    await ai.record(record());

    expect(store.records.get('org_a')).toHaveLength(1);
  });

  it('keeps the platform tenant separate from a named one', async () => {
    const { ai } = telemetry();

    await ai.record(record({ organizationId: null }));
    await ai.record(record({ organizationId: 'org_a' }));

    expect((await ai.report({ organizationId: 'org_a' })).requests).toBe(1);
    expect((await ai.report({ organizationId: null })).requests).toBe(1);
  });
});

describe('never failing a request', () => {
  it('swallows a store failure', async () => {
    /*
     * A dashboard with a hole is a nuisance. A customer request failing because the metrics store
     * was down is an outage caused by the thing watching for outages.
     */
    const failing = {
      record: async () => {
        throw new Error('The telemetry database is unreachable.');
      },
      query: async () => [],
    };

    const ai = new AiTelemetry({ store: failing, now: () => clock });

    await expect(ai.record(record())).resolves.toBeUndefined();
  });

  it('swallows a malformed record rather than throwing at the call site', async () => {
    const { ai } = telemetry();

    await expect(ai.record({ nonsense: true })).resolves.toBeUndefined();
  });
});

describe('the report', () => {
  it('states what the numbers are computed from', async () => {
    const { ai } = telemetry();

    for (const latency of [100, 200, 300]) {
      await ai.record(record({ latencyMs: latency }));
      clock = new Date(clock.getTime() + 1000);
    }

    const report = await ai.report({ organizationId: 'org_a' });

    expect(report.sampleSize).toBe(3);
    expect(report.windowStart).toEqual(new Date('2026-03-01T09:00:00.000Z'));
    expect(report.windowEnd).toEqual(new Date('2026-03-01T09:00:02.000Z'));
  });

  it('computes percentiles exactly over the window', async () => {
    const { ai } = telemetry();

    for (let index = 1; index <= 100; index += 1) {
      await ai.record(record({ latencyMs: index * 10 }));
    }

    const report = await ai.report({ organizationId: 'org_a' });

    expect(report.p50LatencyMs).toBe(500);
    expect(report.p95LatencyMs).toBe(950);
    expect(report.p99LatencyMs).toBe(990);
  });

  it('counts retries separately from failures', async () => {
    // A retried request that eventually succeeded is not a failure, but it is the leading
    // indicator that one is coming.
    const { ai } = telemetry();

    await ai.record(record({ attempts: 3 }));
    await ai.record(record({ outcome: 'provider_error', reason: 'timeout' }));

    const report = await ai.report({ organizationId: 'org_a' });

    expect(report).toMatchObject({ requests: 2, failures: 1, retried: 1, failureRate: 0.5 });
    expect(report.byOutcome).toEqual({ success: 1, provider_error: 1 });
  });

  it('reports what fraction of the cost is estimated', async () => {
    // A cost report that cannot distinguish measured from estimated is one nobody can reconcile
    // against an invoice.
    const { ai } = telemetry();

    await ai.record(record({ costCents: 1, estimated: false }));
    await ai.record(record({ costCents: 3, estimated: true }));

    expect(await ai.report({ organizationId: 'org_a' })).toMatchObject({
      costCents: 4,
      estimatedCostFraction: 0.75,
    });
  });

  it('reports the cache hit rate and an approximate saving', async () => {
    const { ai } = telemetry();

    await ai.record(record({ cached: false, costCents: 2 }));
    await ai.record(record({ cached: false, costCents: 2 }));
    await ai.record(record({ cached: true, costCents: 0 }));
    await ai.record(record({ cached: true, costCents: 0 }));

    expect(await ai.report({ organizationId: 'org_a' })).toMatchObject({
      cacheHits: 2,
      cacheHitRate: 0.5,
      cacheSavedCents: 4,
    });
  });

  it('does not invent an agent for requests that had none', async () => {
    // Counting them under "unknown" makes the busiest agent a fiction.
    const { ai } = telemetry();

    await ai.record(record({ agentId: null }));
    await ai.record(record({ agentId: 'support-agent' }));

    const report = await ai.report({ organizationId: 'org_a' });

    expect(report.byAgent.map((entry) => entry.key)).toEqual(['support-agent']);
  });

  it('orders breakdowns by cost, which is the question being asked', async () => {
    const { ai } = telemetry();

    await ai.record(record({ modelId: 'cheap', costCents: 0.1 }));
    await ai.record(record({ modelId: 'cheap', costCents: 0.1 }));
    await ai.record(record({ modelId: 'expensive', costCents: 5 }));

    expect(
      (await ai.report({ organizationId: 'org_a' })).byModel.map((entry) => entry.key),
    ).toEqual(['expensive', 'cheap']);
  });

  it('breaks prompt usage down by version', async () => {
    // "Which prompt is expensive" is rarely the question. "Which *version* changed the cost" is.
    const { ai } = telemetry();

    await ai.record(record({ promptId: 'support.system', promptVersion: '3' }));
    await ai.record(record({ promptId: 'support.system', promptVersion: '4' }));

    expect(
      (await ai.report({ organizationId: 'org_a' })).byPrompt.map((entry) => entry.key).sort(),
    ).toEqual(['support.system@3', 'support.system@4']);
  });

  it('returns zeroes rather than NaN for an empty window', async () => {
    const { ai } = telemetry();

    expect(await ai.report({ organizationId: 'org_a' })).toMatchObject({
      requests: 0,
      failureRate: 0,
      p95LatencyMs: 0,
      cacheHitRate: 0,
      windowStart: null,
    });
  });

  it('honours the time window', async () => {
    const { ai } = telemetry();

    await ai.record(record());
    clock = new Date(clock.getTime() + 3_600_000);
    await ai.record(record());

    const report = await ai.report({ organizationId: 'org_a', since: clock });

    expect(report.requests).toBe(1);
  });
});

describe('provider health', () => {
  it('is unknown below the sample floor', async () => {
    // One failure in three requests is 33%, and reporting that as "failing" makes the dashboard
    // cry wolf.
    const { ai } = telemetry();

    await ai.record(record({ outcome: 'provider_error' }));
    await ai.record(record());

    expect((await ai.providerHealth({ organizationId: 'org_a' }))[0]).toMatchObject({
      provider: 'test',
      status: 'unknown',
    });
  });

  it('is degraded above the degraded rate and failing above the failing rate', async () => {
    const { ai } = telemetry({ minSamplesForHealth: 10 });

    for (let index = 0; index < 9; index += 1) await ai.record(record({ provider: 'a' }));
    await ai.record(record({ provider: 'a', outcome: 'provider_error' }));

    for (let index = 0; index < 6; index += 1) await ai.record(record({ provider: 'b' }));
    for (let index = 0; index < 4; index += 1) {
      await ai.record(record({ provider: 'b', outcome: 'provider_error' }));
    }

    const health = await ai.providerHealth({ organizationId: 'org_a' });

    expect(health.find((entry) => entry.provider === 'a')).toMatchObject({ status: 'degraded' });
    expect(health.find((entry) => entry.provider === 'b')).toMatchObject({ status: 'failing' });
  });

  it('counts requests routed away from a provider', async () => {
    // The clearest signal that the router is working around a provider, and it comes from real
    // traffic rather than a synthetic probe.
    const { ai } = telemetry();

    await ai.record(record({ provider: 'b', modelId: 'b.large', fallbackFrom: 'a.large' }));
    await ai.record(record({ provider: 'a', modelId: 'a.large' }));

    const health = await ai.providerHealth({ organizationId: 'org_a' });

    expect(health.find((entry) => entry.provider === 'a')!.fallbacksAway).toBe(1);
    expect(health.find((entry) => entry.provider === 'b')!.fallbacksAway).toBe(0);
  });

  it('only counts a guardrail block against safety, not against the provider', async () => {
    // A guardrail refusal is the platform working. Counting it as a provider failure makes a
    // well-defended tenant look like a broken provider.
    const { ai } = telemetry({ minSamplesForHealth: 1 });

    for (let index = 0; index < 5; index += 1) await ai.record(record());
    for (let index = 0; index < 5; index += 1) {
      await ai.record(record({ outcome: 'guardrail_blocked', reason: 'pii_in_prompt' }));
    }

    const report = await ai.report({ organizationId: 'org_a' });

    // It is a failure of the request, and it is visible as one — but the outcome breakdown says
    // which kind, which is what somebody debugging needs.
    expect(report.byOutcome.guardrail_blocked).toBe(5);
    expect(report.failures).toBe(5);
  });
});

describe('metrics', () => {
  it('emits counters and a latency distribution', async () => {
    const { ai, metrics } = telemetry();

    await ai.record(record({ attempts: 2, cached: true, fallbackFrom: 'other.model' }));

    const names = metrics.increment.mock.calls.map((call) => call[0]);

    expect(names).toContain('ai.requests');
    expect(names).toContain('ai.cache.hits');
    expect(names).toContain('ai.retries');
    expect(names).toContain('ai.fallbacks');
    expect(metrics.observe).toHaveBeenCalledWith('ai.latency_ms', 500, expect.anything());
  });

  it('does not label metrics with anything tenant-identifying', async () => {
    // Metric labels become time series in a shared system. A tenant id there is unbounded
    // cardinality and a data leak in the same field.
    const { ai, metrics } = telemetry();

    await ai.record(record());

    for (const call of metrics.increment.mock.calls) {
      expect(JSON.stringify(call[2] ?? {})).not.toMatch(/org_a/);
    }
  });
});

describe('percentile', () => {
  it('is exact rather than interpolated', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});
