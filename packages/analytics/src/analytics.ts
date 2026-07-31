import type { TelemetryCategory, TelemetryEvent } from '@trustos/telemetry';

/**
 * Summaries over collected telemetry.
 *
 * Reads events and produces counts. It never fetches, never stores and never sends — the input is
 * whatever the local sink holds, which means an analytics dashboard works in an air-gapped
 * deployment and shows exactly what that deployment generated.
 *
 * The one editorial decision in here: **every summary reports the sample it was computed from.**
 * A "76% adoption" with no denominator is a number that gets quoted in a slide and then in a
 * decision. `{ value: 76, of: 17 }` is a number somebody correctly distrusts.
 */

export interface Count {
  key: string;
  count: number;
}

export interface Ratio {
  key: string;
  /** Percentage, rounded. */
  value: number;
  /** The denominator. Always shown — see the header. */
  of: number;
}

export interface AnalyticsSummary {
  eventCount: number;
  /** Window covered, so a reader knows whether "quiet" means quiet or means recent. */
  from: string | null;
  to: string | null;
  byCategory: Count[];
  topEvents: Count[];
  errorRate: Ratio | null;
  slowest: Array<{ name: string; p50: number; p95: number; samples: number }>;
}

export function summarize(events: readonly TelemetryEvent[], topN = 10): AnalyticsSummary {
  if (events.length === 0) {
    return {
      eventCount: 0,
      from: null,
      to: null,
      byCategory: [],
      topEvents: [],
      errorRate: null,
      slowest: [],
    };
  }

  const times = events.map((event) => event.occurredAt).sort();

  return {
    eventCount: events.length,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    byCategory: countBy(events, (event) => event.category),
    topEvents: countBy(events, (event) => event.name).slice(0, topN),
    errorRate: errorRateOf(events),
    slowest: durationsOf(events).slice(0, topN),
  };
}

function countBy(
  events: readonly TelemetryEvent[],
  key: (event: TelemetryEvent) => string,
): Count[] {
  const counts = new Map<string, number>();

  for (const event of events) {
    const value = key(event);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

/**
 * The share of outcome-bearing events that failed.
 *
 * Computed only over events that *have* an outcome, not over all events. Dividing failures by
 * everything makes a system look more reliable the more telemetry it emits, which is the wrong
 * incentive to build into a number people watch.
 */
function errorRateOf(events: readonly TelemetryEvent[]): Ratio | null {
  const withOutcome = events.filter((event) => event.dimensions.outcome !== undefined);

  if (withOutcome.length === 0) return null;

  const failures = withOutcome.filter((event) => event.dimensions.outcome === 'failure').length;

  return {
    key: 'error rate',
    value: Math.round((failures / withOutcome.length) * 100),
    of: withOutcome.length,
  };
}

/**
 * Percentiles per event name.
 *
 * p50 and p95, never a mean. A mean latency is dominated by whatever the slowest call was doing,
 * and it hides the shape entirely — a system where half the calls are instant and half take a
 * second has the same mean as one where every call takes 500ms, and they are not the same system.
 */
function durationsOf(
  events: readonly TelemetryEvent[],
): Array<{ name: string; p50: number; p95: number; samples: number }> {
  const byName = new Map<string, number[]>();

  for (const event of events) {
    const duration = event.measurements.durationMs;
    if (duration === undefined) continue;

    byName.set(event.name, [...(byName.get(event.name) ?? []), duration]);
  }

  return [...byName.entries()]
    .map(([name, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);

      return {
        name,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        samples: sorted.length,
      };
    })
    .sort((a, b) => b.p95 - a.p95);
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;

  // Nearest-rank. Interpolating between two samples invents a measurement that was never taken.
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)] as number);
}

/**
 * Feature adoption: what share of installations used each feature.
 *
 * Takes the installation count separately rather than deriving it, because the events only prove
 * that *something* was used — an installation that never emitted an event is invisible here, and
 * counting only the visible ones reports 100% adoption of everything.
 */
export function featureAdoption(events: readonly TelemetryEvent[], installations: number): Ratio[] {
  const features = events.filter((event) => event.category === 'feature');
  const byFeature = new Map<string, Set<string>>();

  for (const event of features) {
    const installation = event.dimensions.installation ?? 'unknown';
    const key = event.name;

    byFeature.set(key, (byFeature.get(key) ?? new Set()).add(installation));
  }

  return [...byFeature.entries()]
    .map(([key, seen]) => ({
      key,
      value: installations === 0 ? 0 : Math.round((seen.size / installations) * 100),
      of: installations,
    }))
    .sort((a, b) => b.value - a.value);
}

/** Module popularity, by how many distinct installations reported using each. */
export function modulePopularity(events: readonly TelemetryEvent[]): Count[] {
  const byModule = new Map<string, Set<string>>();

  for (const event of events) {
    if (event.category !== 'module') continue;

    const module = event.dimensions.module;
    if (!module) continue;

    byModule.set(
      module,
      (byModule.get(module) ?? new Set()).add(event.dimensions.installation ?? 'unknown'),
    );
  }

  return [...byModule.entries()]
    .map(([key, installations]) => ({ key, count: installations.size }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

/** Which framework versions are in use. The number a release manager needs before an EOL. */
export function upgradeAdoption(events: readonly TelemetryEvent[]): Count[] {
  return countBy(
    events.filter((event) => event.dimensions.frameworkVersion !== undefined),
    (event) => event.dimensions.frameworkVersion as string,
  );
}

/**
 * Error counts per day, oldest first.
 *
 * A trend, not a total. "Forty errors" is unreadable; "four a day rising to twelve" is a decision.
 */
export function errorTrend(events: readonly TelemetryEvent[]): Count[] {
  const errors = events.filter(
    (event) => event.category === 'error' || event.dimensions.outcome === 'failure',
  );

  return countBy(errors, (event) => event.occurredAt.slice(0, 10)).sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );
}

/** Events in a window. For a dashboard that shows "the last 30 days". */
export function within(events: readonly TelemetryEvent[], from: Date, to: Date): TelemetryEvent[] {
  const start = from.toISOString();
  const end = to.toISOString();

  return events.filter((event) => event.occurredAt >= start && event.occurredAt < end);
}

export function byCategory(
  events: readonly TelemetryEvent[],
  category: TelemetryCategory,
): TelemetryEvent[] {
  return events.filter((event) => event.category === category);
}
