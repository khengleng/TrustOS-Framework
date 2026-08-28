import { describe, expect, it } from 'vitest';
import {
  errorTrend,
  featureAdoption,
  modulePopularity,
  summarize,
  upgradeAdoption,
  within,
} from './index';
import type { TelemetryEvent } from '@trustos/telemetry';

const event = (name: string, overrides: Partial<TelemetryEvent> = {}): TelemetryEvent => ({
  category: 'cli',
  name,
  dimensions: {},
  measurements: {},
  occurredAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

describe('summaries', () => {
  it('handles an empty set without pretending', () => {
    expect(summarize([])).toMatchObject({ eventCount: 0, errorRate: null, from: null });
  });

  it('reports the window it covers', () => {
    // So a reader knows whether "quiet" means quiet or means recent.
    const summary = summarize([
      event('a.b', { occurredAt: '2026-07-01T00:00:00.000Z' }),
      event('a.b', { occurredAt: '2026-07-05T00:00:00.000Z' }),
    ]);

    expect(summary.from).toBe('2026-07-01T00:00:00.000Z');
    expect(summary.to).toBe('2026-07-05T00:00:00.000Z');
  });

  it('computes the error rate only over events that have an outcome', () => {
    /*
     * Dividing failures by everything makes a system look more reliable the more telemetry it
     * emits, which is the wrong incentive to build into a number people watch.
     */
    const summary = summarize([
      event('a.b', { dimensions: { outcome: 'success' } }),
      event('a.b', { dimensions: { outcome: 'failure' } }),
      event('c.d'),
      event('c.d'),
    ]);

    expect(summary.errorRate).toEqual({ key: 'error rate', value: 50, of: 2 });
  });

  it('reports percentiles rather than a mean', () => {
    /*
     * A system where half the calls are instant and half take a second has the same mean as one
     * where every call takes 500ms, and they are not the same system.
     */
    const events = [10, 10, 10, 1000].map((durationMs) =>
      event('slow.thing', { measurements: { durationMs } }),
    );

    expect(summarize(events).slowest[0]).toEqual({
      name: 'slow.thing',
      p50: 10,
      p95: 1000,
      samples: 4,
    });
  });
});

describe('adoption', () => {
  it('takes the installation count rather than deriving it', () => {
    /*
     * An installation that never emitted an event is invisible in the data; counting only the
     * visible ones reports 100% adoption of everything.
     */
    const events = [
      event('reports.exported', { category: 'feature', dimensions: { installation: 'a' } }),
      event('reports.exported', { category: 'feature', dimensions: { installation: 'a' } }),
    ];

    expect(featureAdoption(events, 10)).toEqual([{ key: 'reports.exported', value: 10, of: 10 }]);
  });

  it('counts distinct installations per module, not events', () => {
    const events = [
      event('module.used', {
        category: 'module',
        dimensions: { module: 'search', installation: 'a' },
      }),
      event('module.used', {
        category: 'module',
        dimensions: { module: 'search', installation: 'a' },
      }),
      event('module.used', {
        category: 'module',
        dimensions: { module: 'search', installation: 'b' },
      }),
    ];

    expect(modulePopularity(events)).toEqual([{ key: 'search', count: 2 }]);
  });

  it('reports which framework versions are in use', () => {
    const events = [
      event('a.b', { dimensions: { frameworkversion: 'x' } }),
      event('a.b', { dimensions: { frameworkVersion: '0.5.0' } }),
      event('a.b', { dimensions: { frameworkVersion: '0.5.0' } }),
    ];

    expect(upgradeAdoption(events)).toEqual([{ key: '0.5.0', count: 2 }]);
  });
});

describe('trends', () => {
  it('reports errors per day, oldest first', () => {
    // "Forty errors" is unreadable; "four a day rising to twelve" is a decision.
    const events = [
      event('a.b', { category: 'error', occurredAt: '2026-07-02T00:00:00.000Z' }),
      event('a.b', { category: 'error', occurredAt: '2026-07-01T00:00:00.000Z' }),
      event('a.b', { dimensions: { outcome: 'failure' }, occurredAt: '2026-07-02T10:00:00.000Z' }),
    ];

    expect(errorTrend(events)).toEqual([
      { key: '2026-07-01', count: 1 },
      { key: '2026-07-02', count: 2 },
    ]);
  });

  it('filters to a window, half-open at the top', () => {
    const events = [
      event('a.b', { occurredAt: '2026-06-30T00:00:00.000Z' }),
      event('a.b', { occurredAt: '2026-07-01T00:00:00.000Z' }),
      event('a.b', { occurredAt: '2026-07-02T00:00:00.000Z' }),
    ];

    expect(
      within(events, new Date('2026-07-01'), new Date('2026-07-02')).map((e) => e.occurredAt),
    ).toEqual(['2026-07-01T00:00:00.000Z']);
  });
});
