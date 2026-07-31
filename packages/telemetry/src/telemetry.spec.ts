import { describe, expect, it } from 'vitest';
import {
  assertNoIdentifiers,
  describeExport,
  InMemoryTelemetrySink,
  TelemetryCollector,
} from './index';

/**
 * The tests are about the three promises: off by default, local by default, and structurally
 * incapable of carrying tenant data.
 */

const clock = () => new Date('2026-07-01T12:00:00.000Z');

describe('consent', () => {
  it('records nothing when disabled', () => {
    const sink = new InMemoryTelemetrySink();
    const telemetry = new TelemetryCollector({ enabled: false, sink, now: clock });

    expect(telemetry.record({ category: 'cli', name: 'command.run' })).toBeNull();
    expect(sink.events).toEqual([]);
  });

  it('does not throw when disabled', () => {
    /*
     * A collector that threw when off would push every caller into `if (telemetry.enabled)`, and
     * the one that forgot would crash a production path over a metric.
     */
    const telemetry = new TelemetryCollector({ enabled: false, now: clock });

    expect(() => telemetry.record({ category: 'cli', name: 'command.run' })).not.toThrow();
  });

  it('records only the categories it was told to', () => {
    const sink = new InMemoryTelemetrySink();
    const telemetry = new TelemetryCollector({
      enabled: true,
      sink,
      categories: ['error'],
      now: clock,
    });

    telemetry.record({ category: 'cli', name: 'command.run' });
    telemetry.record({ category: 'error', name: 'request.failed' });

    expect(sink.events.map((event) => event.category)).toEqual(['error']);
  });
});

describe('tenant data', () => {
  it('refuses a dimension that looks like an identifier', () => {
    // The interesting failure is not malice: it is somebody putting an order id in a dimension
    // to make a dashboard more useful.
    for (const value of [
      'c1234567890abcdefghijklmn',
      '550e8400-e29b-41d4-a716-446655440000',
      'someone@example.test',
      '+855 12 345 678',
    ]) {
      expect(() => assertNoIdentifiers({ subject: value })).toThrow(/counts without identifying/);
    }
  });

  it('accepts a label', () => {
    expect(() => assertNoIdentifiers({ command: 'upgrade', outcome: 'success' })).not.toThrow();
  });

  it('has nowhere to put free text', () => {
    const sink = new InMemoryTelemetrySink();
    const telemetry = new TelemetryCollector({ enabled: true, sink, now: clock });

    // A message would be rejected by the dimension pattern; there is no other string field.
    expect(() =>
      telemetry.record({
        category: 'error',
        name: 'x.y',
        dimensions: { message: 'Order 4471 failed' },
      }),
    ).toThrow();
  });

  it('records the error type and never its message', () => {
    const sink = new InMemoryTelemetrySink();
    const telemetry = new TelemetryCollector({ enabled: true, sink, now: clock });

    void telemetry
      .time({ category: 'cli', name: 'command.run' }, async () => {
        throw new TypeError('customer Dara Sok not found');
      })
      .catch(() => undefined);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const event = sink.events[0];
        expect(event?.dimensions.error).toBe('typeerror');
        expect(JSON.stringify(event)).not.toMatch(/Dara/);
        resolve();
      }, 0);
    });
  });
});

describe('hashing', () => {
  it('refuses to hash without a salt', () => {
    // An unsalted hash of a known identifier space is reversible.
    const telemetry = new TelemetryCollector({ enabled: true, now: clock });

    expect(telemetry.hashIdentifier('org_a')).toBeNull();
  });

  it('gives a different pseudonym per installation', () => {
    const a = new TelemetryCollector({ enabled: true, salt: 'installation-a', now: clock });
    const b = new TelemetryCollector({ enabled: true, salt: 'installation-b', now: clock });

    expect(a.hashIdentifier('org_a')).not.toBe(b.hashIdentifier('org_a'));
    expect(a.hashIdentifier('org_a')).toBe(a.hashIdentifier('org_a'));
  });
});

describe('the sink', () => {
  it('is bounded, so a long-running process cannot fill memory', () => {
    const sink = new InMemoryTelemetrySink(3);
    const telemetry = new TelemetryCollector({ enabled: true, sink, now: clock });

    for (let index = 0; index < 10; index += 1) {
      telemetry.record({ category: 'cli', name: 'command.run', measurements: { n: index } });
    }

    expect(sink.events).toHaveLength(3);
    expect(sink.events[2]?.measurements.n).toBe(9);
  });
});

describe('describeExport', () => {
  it('says exactly what would be sent', () => {
    // Nobody should have to read source to find out what a framework would transmit.
    const sink = new InMemoryTelemetrySink();
    const telemetry = new TelemetryCollector({ enabled: true, sink, now: clock });

    telemetry.record({
      category: 'cli',
      name: 'command.run',
      dimensions: { command: 'upgrade' },
      measurements: { durationMs: 12 },
    });

    expect(describeExport(sink.events)).toEqual({
      eventCount: 1,
      categories: { cli: 1 },
      dimensionKeys: ['command'],
      measurementKeys: ['durationMs'],
    });
  });
});
