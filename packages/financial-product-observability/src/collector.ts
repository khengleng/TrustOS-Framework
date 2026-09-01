import type { ProductMetricSink } from '@trustsystem/financial-product-core';
import { assertLowCardinality } from './metrics';

/**
 * The in-memory collector.
 *
 * What the runtime reports through when a deployment has not wired an exporter, and what a test
 * asserts against. It holds counts and a small set of quantiles per series, and it is bounded:
 * a collector that grew without limit would be a memory leak in the one component whose job is
 * to notice problems.
 *
 * Quantiles are computed from a **reservoir**, not from every observation. A thousand samples per
 * series is enough for a p95 to be stable and small enough that ten thousand series fit in
 * memory. The alternative — keeping everything — turns the collector into the largest allocation
 * in the process at exactly the volume where it matters.
 *
 * The reservoir is a plain ring buffer rather than a random-replacement one, and that is worth
 * stating: it holds the **most recent** thousand observations, so a p95 read during an incident
 * describes the incident rather than the day. A statistician would call that biased; an operator
 * would call it the point.
 */

export interface SeriesKey {
  name: string;
  dimensions: Record<string, string>;
}

export interface CounterSnapshot {
  name: string;
  dimensions: Record<string, string>;
  value: number;
}

export interface HistogramSnapshot {
  name: string;
  dimensions: Record<string, string>;
  count: number;
  /** Over the reservoir, so a long-running process reports recent behaviour. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Over every observation, so a total is a total. */
  totalMs: number;
}

const RESERVOIR_SIZE = 1000;
const MAX_SERIES = 10_000;

export class MetricCollector implements ProductMetricSink {
  private readonly counters = new Map<string, { key: SeriesKey; value: number }>();
  private readonly histograms = new Map<
    string,
    { key: SeriesKey; samples: number[]; cursor: number; count: number; totalMs: number }
  >();

  /** Series dropped because the cap was reached. Reported, never silent. */
  private droppedSeries = 0;

  increment(name: string, dimensions: Record<string, string>, value = 1): void {
    assertLowCardinality(name, dimensions);

    const id = seriesId(name, dimensions);
    const existing = this.counters.get(id);

    if (existing) {
      existing.value += value;
      return;
    }

    if (this.counters.size >= MAX_SERIES) {
      this.droppedSeries += 1;
      return;
    }

    this.counters.set(id, { key: { name, dimensions }, value });
  }

  observe(name: string, dimensions: Record<string, string>, milliseconds: number): void {
    assertLowCardinality(name, dimensions);

    const id = seriesId(name, dimensions);
    const existing = this.histograms.get(id);

    if (existing) {
      existing.samples[existing.cursor] = milliseconds;
      existing.cursor = (existing.cursor + 1) % RESERVOIR_SIZE;
      existing.count += 1;
      existing.totalMs += milliseconds;
      return;
    }

    if (this.histograms.size >= MAX_SERIES) {
      this.droppedSeries += 1;
      return;
    }

    this.histograms.set(id, {
      key: { name, dimensions },
      samples: [milliseconds],
      cursor: 1 % RESERVOIR_SIZE,
      count: 1,
      totalMs: milliseconds,
    });
  }

  counterSnapshots(): CounterSnapshot[] {
    return [...this.counters.values()]
      .map((entry) => ({ ...entry.key, value: entry.value }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  histogramSnapshots(): HistogramSnapshot[] {
    return [...this.histograms.values()]
      .map((entry) => {
        const sorted = [...entry.samples].sort((left, right) => left - right);

        return {
          ...entry.key,
          count: entry.count,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
          p99: quantile(sorted, 0.99),
          max: sorted[sorted.length - 1] ?? 0,
          totalMs: entry.totalMs,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Series the cap dropped. A non-zero value means the dashboard is incomplete and says so. */
  dropped(): number {
    return this.droppedSeries;
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.droppedSeries = 0;
  }
}

/**
 * A quantile from a sorted sample.
 *
 * Nearest-rank, which is the honest one for a small reservoir: interpolating between two samples
 * produces a number that was never observed, and a p95 latency nobody ever experienced is a
 * number somebody puts in an SLA.
 */
function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

function seriesId(name: string, dimensions: Record<string, string>): string {
  const rendered = Object.keys(dimensions)
    .sort()
    .map((key) => `${key}=${dimensions[key]}`)
    .join(',');

  return `${name}{${rendered}}`;
}
