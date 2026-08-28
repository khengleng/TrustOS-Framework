import { describe, expect, it } from 'vitest';
import {
  HealthRegistry,
  databaseHealthIndicator,
  healthHttpStatus,
  type HealthIndicator,
} from './health';
import {
  InMemoryMetricsRecorder,
  METRICS,
  NoopMetricsRecorder,
  normalizeRoute,
  recordHttpRequest,
} from './metrics';
import { NoopTracer, withSpan, type Span, type Tracer } from './tracing';

const meta = { service: 'trustos-api-example', version: '0.1.0', environment: 'test' };

const indicator = (
  name: string,
  status: 'ok' | 'degraded' | 'down',
  critical = true,
): HealthIndicator => ({
  name,
  critical,
  check: async () => ({ status }),
});

describe('HealthRegistry', () => {
  it('answers liveness without consulting any dependency', async () => {
    const registry = new HealthRegistry(meta, [
      {
        name: 'database',
        check: async () => {
          throw new Error('liveness must not call this');
        },
      },
    ]);

    const report = registry.liveness();
    expect(report.status).toBe('ok');
    expect(report.service).toBe('trustos-api-example');
    expect(report.checks).toEqual([]);
    expect(healthHttpStatus(report)).toBe(200);
  });

  it('reports ready when every check passes', async () => {
    const report = await new HealthRegistry(meta, [indicator('database', 'ok')]).readiness();
    expect(report.status).toBe('ok');
    expect(healthHttpStatus(report)).toBe(200);
    expect(report.checks[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when a critical dependency is down', async () => {
    const report = await new HealthRegistry(meta, [indicator('database', 'down')]).readiness();
    expect(report.status).toBe('down');
    expect(healthHttpStatus(report)).toBe(503);
  });

  it('stays in rotation when a non-critical dependency is down', async () => {
    const report = await new HealthRegistry(meta, [
      indicator('database', 'ok'),
      indicator('search', 'down', false),
    ]).readiness();

    expect(report.status).toBe('degraded');
    expect(healthHttpStatus(report)).toBe(200);
  });

  it('treats a thrown check as down rather than crashing the probe', async () => {
    const registry = new HealthRegistry(meta, [
      {
        name: 'database',
        check: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    ]);

    const report = await registry.readiness();
    expect(report.status).toBe('down');
    expect(report.checks[0]?.detail).toBe('ECONNREFUSED');
  });

  it('accepts indicators registered after construction', async () => {
    const registry = new HealthRegistry(meta);
    registry.register(indicator('cache', 'ok'));
    expect((await registry.readiness()).checks).toHaveLength(1);
  });
});

describe('databaseHealthIndicator', () => {
  it('summarizes a failure instead of echoing the driver error', async () => {
    const check = databaseHealthIndicator(async () => ({
      ok: false,
      latencyMs: 12,
      error: 'connect ECONNREFUSED postgres://user:hunter2@10.0.0.4:5432',
    }));

    const result = await check.check();
    expect(result.status).toBe('down');
    expect(result.detail).toBe('database unreachable');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('reports latency when healthy', async () => {
    const check = databaseHealthIndicator(async () => ({ ok: true, latencyMs: 4 }));
    expect(await check.check()).toEqual({ status: 'ok', detail: '4ms' });
  });
});

describe('metrics', () => {
  it('records a count and a duration per request', () => {
    const recorder = new InMemoryMetricsRecorder();
    recordHttpRequest(recorder, {
      method: 'GET',
      path: '/api/organizations/org_abc123def/members',
      statusCode: 200,
      durationMs: 12.5,
    });

    expect(recorder.valuesFor(METRICS.HTTP_REQUESTS)).toEqual([1]);
    expect(recorder.valuesFor(METRICS.HTTP_DURATION_MS)).toEqual([12.5]);
    expect(recorder.valuesFor(METRICS.HTTP_ERRORS)).toEqual([]);
    expect(recorder.entries[0]?.labels).toEqual({
      method: 'GET',
      route: '/api/organizations/:id/members',
      status_class: '2xx',
    });
  });

  it('counts server errors separately', () => {
    const recorder = new InMemoryMetricsRecorder();
    recordHttpRequest(recorder, { method: 'POST', path: '/api/x', statusCode: 500, durationMs: 3 });
    expect(recorder.valuesFor(METRICS.HTTP_ERRORS)).toEqual([1]);
  });

  it('keeps label cardinality bounded', () => {
    expect(normalizeRoute('/api/users/123')).toBe('/api/users/:id');
    expect(normalizeRoute('/api/users/clh3k4j5k6l7m8n9o0p1q2r3')).toBe('/api/users/:id');
    expect(normalizeRoute('/api/users/user_A1b2C3d4')).toBe('/api/users/:id');
    expect(normalizeRoute('/api/members?page=2')).toBe('/api/members');
    expect(normalizeRoute('/api/organizations')).toBe('/api/organizations');
  });

  it('has a default recorder that does nothing and never throws', () => {
    const noop = new NoopMetricsRecorder();
    expect(() =>
      recordHttpRequest(noop, { method: 'GET', path: '/', statusCode: 200, durationMs: 1 }),
    ).not.toThrow();
  });
});

describe('withSpan', () => {
  it('ends the span on success and on failure', async () => {
    const events: string[] = [];
    const tracer: Tracer = {
      startSpan: () =>
        ({
          setAttribute: () => events.push('attribute'),
          setStatus: (status: string) => events.push(`status:${status}`),
          recordException: () => events.push('exception'),
          end: () => events.push('end'),
        }) as unknown as Span,
    };

    await withSpan(tracer, 'ok-span', async () => 'value');
    expect(events).toEqual(['status:ok', 'end']);

    events.length = 0;
    await expect(
      withSpan(tracer, 'failing-span', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(events).toEqual(['exception', 'status:error', 'end']);
  });

  it('works with the no-op tracer', async () => {
    await expect(withSpan(new NoopTracer(), 'noop', async () => 7)).resolves.toBe(7);
  });
});
