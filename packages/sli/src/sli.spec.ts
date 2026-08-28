import { describe, expect, it } from 'vitest';
import {
  SliRegistry,
  aggregate,
  excludeMaintenance,
  sliDefinitionSchema,
  sliMeasurementSchema,
  sufficientToJudge,
} from './index';

function definition(overrides: Record<string, unknown> = {}) {
  return sliDefinitionSchema.parse({
    sliId: 'payments.api.availability',
    serviceId: 'payments.api',
    kind: 'availability',
    name: 'Payments API availability',
    goodEventDefinition: 'An HTTP request answered with a status below 500 within the timeout.',
    validEventDefinition:
      'Every authenticated request, excluding those rejected as malformed by the client.',
    source: 'ingress access logs',
    ...overrides,
  });
}

function measurement(overrides: Record<string, unknown> = {}) {
  return sliMeasurementSchema.parse({
    sliId: 'payments.api.availability',
    windowStart: '2026-06-01T00:00:00.000Z',
    windowEnd: '2026-06-01T01:00:00.000Z',
    goodEvents: 9_990,
    validEvents: 10_000,
    ...overrides,
  });
}

describe('defining an indicator', () => {
  it('requires a latency indicator to state its threshold', () => {
    // Without a threshold it is an average, and an average hides the tail that people complain about.
    expect(() => definition({ kind: 'latency', thresholdMs: null })).toThrow(/threshold/);
  });

  it('accepts a latency indicator that states one', () => {
    expect(definition({ kind: 'latency', thresholdMs: 500 }).thresholdMs).toBe(500);
  });

  it('refuses a measurement with more good events than valid ones', () => {
    expect(() => measurement({ goodEvents: 11_000 })).toThrow(/counter is wrong/);
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => measurement({ windowEnd: '2026-05-31T00:00:00.000Z' })).toThrow(
      /ends after it starts/,
    );
  });
});

describe('aggregating', () => {
  it('sums counts and divides once', () => {
    const value = aggregate([measurement(), measurement({ goodEvents: 10_000 })]);
    expect(value.goodEvents).toBe(19_990);
    expect(value.percentage).toBe(99.95);
  });

  it('weights a busy hour more than a quiet one', () => {
    /*
     * The reason counts are stored rather than percentages. Averaging the two percentages here
     * gives 50%; the truth is that ten of a thousand and one requests failed.
     */
    const value = aggregate([
      measurement({ goodEvents: 1_000, validEvents: 1_000 }),
      measurement({ goodEvents: 0, validEvents: 1 }),
    ]);

    expect(value.percentage).toBe(99.9001);
  });

  it('reports an unobserved window as unmeasured, not as perfect', () => {
    /*
     * The property worth naming. If an empty window read 100%, an outage that stopped all traffic
     * would improve the number, and the objective would be met precisely because the service was
     * unreachable.
     */
    const value = aggregate([measurement({ goodEvents: 0, validEvents: 0 })]);

    expect(value.ratio).toBeNull();
    expect(value.unmeasuredReason).toBe('no_valid_events');
  });

  it('spans the widest window it was given', () => {
    const value = aggregate([
      measurement(),
      measurement({
        windowStart: '2026-06-01T05:00:00.000Z',
        windowEnd: '2026-06-01T06:00:00.000Z',
      }),
    ]);

    expect(value.windowEnd).toBe('2026-06-01T06:00:00.000Z');
  });

  it('refuses to mix indicators', () => {
    expect(() =>
      aggregate([measurement(), measurement({ sliId: 'payments.api.latency' })]),
    ).toThrow(/do not aggregate/);
  });

  it('refuses to aggregate nothing', () => {
    expect(() => aggregate([])).toThrow(/no defined answer/);
  });
});

describe('maintenance exclusion', () => {
  const registry = {
    inMaintenance: (_serviceId: string, at: Date) =>
      at.toISOString() === '2026-06-01T02:00:00.000Z' ? ({} as never) : null,
  };

  it('drops the buckets inside an approved window', () => {
    // Planned work should not consume the budget kept for unplanned failure.
    const kept = excludeMaintenance(
      [
        measurement(),
        measurement({
          windowStart: '2026-06-01T02:00:00.000Z',
          windowEnd: '2026-06-01T03:00:00.000Z',
        }),
      ],
      { serviceId: 'payments.api', registry },
    );

    expect(kept).toHaveLength(1);
  });

  it('leaves the raw measurements untouched', () => {
    // The exclusion is auditable precisely because it is applied late, over intact counts.
    const raw = [measurement()];
    excludeMaintenance(raw, { serviceId: 'payments.api', registry });
    expect(raw).toHaveLength(1);
  });
});

describe('whether a value can judge compliance', () => {
  it('accepts a window with enough traffic', () => {
    expect(
      sufficientToJudge(aggregate([measurement()]), { objectivePercentage: 99.9 }).sufficient,
    ).toBe(true);
  });

  it('refuses a window too thin to distinguish compliance from luck', () => {
    /*
     * Fifty requests against a 99.9% objective: one failure is 2%, twenty times the entire
     * allowance. Such a window can neither confirm nor deny compliance, so it says so instead of
     * reporting a pass.
     */
    const thin = aggregate([measurement({ goodEvents: 50, validEvents: 50 })]);
    const verdict = sufficientToJudge(thin, { objectivePercentage: 99.9 });

    expect(verdict.sufficient).toBe(false);
    expect(verdict.reason).toContain('too thin');
  });

  it('refuses an empty window', () => {
    const empty = aggregate([measurement({ goodEvents: 0, validEvents: 0 })]);
    expect(sufficientToJudge(empty, { objectivePercentage: 99.9 }).sufficient).toBe(false);
  });

  it('honours an explicit minimum event count', () => {
    const value = aggregate([measurement()]);
    expect(
      sufficientToJudge(value, { objectivePercentage: 99.9, minimumEvents: 50_000 }).sufficient,
    ).toBe(false);
  });
});

describe('the registry', () => {
  it('refuses a measurement for an indicator nobody defined', () => {
    expect(() => new SliRegistry().valueOf('payments.api.availability', [measurement()])).toThrow(
      /not defined/,
    );
  });

  it('ignores measurements belonging to another indicator', () => {
    const registry = new SliRegistry([definition()]);
    const value = registry.valueOf('payments.api.availability', [
      measurement(),
      measurement({ sliId: 'other.indicator', goodEvents: 0, validEvents: 1_000_000 }),
    ]);

    expect(value.validEvents).toBe(10_000);
  });

  it('lists what is measured for a service', () => {
    const registry = new SliRegistry([
      definition(),
      definition({ sliId: 'payments.api.latency', kind: 'latency', thresholdMs: 500 }),
    ]);

    expect(registry.forService('payments.api')).toHaveLength(2);
  });

  it('refuses a duplicate definition', () => {
    const registry = new SliRegistry([definition()]);
    expect(() => registry.register(definition())).toThrow(/already defined/);
  });
});
