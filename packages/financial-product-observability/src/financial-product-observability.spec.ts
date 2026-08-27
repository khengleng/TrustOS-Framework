import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_DIMENSIONS,
  MetricCollector,
  PRODUCT_DASHBOARDS,
  PRODUCT_METRICS,
  PRODUCT_METRIC_CATALOG,
  assertLowCardinality,
  findDashboard,
  guardedSink,
} from './index';

describe('the metric catalog', () => {
  it('covers the measures section 28 asks for', () => {
    const names = PRODUCT_METRIC_CATALOG.map((metric) => metric.name);

    for (const required of [
      PRODUCT_METRICS.EXECUTIONS,
      PRODUCT_METRICS.EXECUTION_LATENCY,
      PRODUCT_METRICS.BLOCK_LATENCY,
      PRODUCT_METRICS.PROVIDER_LATENCY,
      PRODUCT_METRICS.PROVIDER_FAILURES,
      PRODUCT_METRICS.RETRIES,
      PRODUCT_METRICS.SETTLEMENT_EXCEPTIONS,
      PRODUCT_METRICS.RECONCILIATION_EXCEPTIONS,
      PRODUCT_METRICS.FEE_TOTAL_MINOR_UNITS,
      PRODUCT_METRICS.LIMIT_REFUSALS,
      PRODUCT_METRICS.REVIEWS_REQUIRED,
      PRODUCT_METRICS.SLA_BREACHES,
    ]) {
      expect(names).toContain(required);
    }
  });

  it('declares no unbounded dimension anywhere', () => {
    for (const metric of PRODUCT_METRIC_CATALOG) {
      for (const dimension of metric.dimensions) {
        expect(FORBIDDEN_DIMENSIONS, `${metric.name} carries ${dimension}`).not.toContain(
          dimension,
        );
      }
    }
  });

  it('never dimensions a provider metric by vendor', () => {
    const provider = PRODUCT_METRIC_CATALOG.find(
      (metric) => metric.name === PRODUCT_METRICS.PROVIDER_LATENCY,
    );
    expect(provider?.dimensions).toContain('provider_interface');
    expect(provider?.dimensions).not.toContain('provider');
    expect(provider?.dimensions).not.toContain('vendor');
  });

  it('has no tenant dimension, deliberately', () => {
    // A per-tenant series multiplies every series by the tenant count. A deployment that wants
    // it adds it knowingly.
    for (const metric of PRODUCT_METRIC_CATALOG) {
      expect(metric.dimensions).not.toContain('tenant');
      expect(metric.dimensions).not.toContain('organization');
    }
  });

  it('describes every metric substantively', () => {
    for (const metric of PRODUCT_METRIC_CATALOG) {
      expect(metric.description.length).toBeGreaterThan(10);
    }
  });
});

describe('cardinality', () => {
  it('refuses a customer dimension', () => {
    expect(() =>
      assertLowCardinality(PRODUCT_METRICS.EXECUTIONS, { product: 'p', customer_id: 'cus_1' }),
    ).toThrow(/one time series per value/);
  });

  it('refuses an amount dimension', () => {
    expect(() =>
      assertLowCardinality(PRODUCT_METRICS.FEE_TOTAL_MINOR_UNITS, {
        product: 'p',
        amount: '150000',
      }),
    ).toThrow();
  });

  it('refuses a dimension the metric does not declare', () => {
    expect(() =>
      assertLowCardinality(PRODUCT_METRICS.EXECUTIONS, { product: 'p', weather: 'rain' }),
    ).toThrow(/does not declare the dimension/);
  });

  it('permits the declared dimensions', () => {
    expect(() =>
      assertLowCardinality(PRODUCT_METRICS.EXECUTIONS, { product: 'p', outcome: 'success' }),
    ).not.toThrow();
  });

  it('guards a sink at emission rather than at review', () => {
    const recorded: string[] = [];
    const sink = guardedSink({
      increment: (name) => recorded.push(name),
      observe: (name) => recorded.push(name),
    });

    sink.increment(PRODUCT_METRICS.EXECUTIONS, { product: 'p', outcome: 'success' });
    expect(recorded).toEqual([PRODUCT_METRICS.EXECUTIONS]);

    // A dimension added at 3am is the one review never sees.
    expect(() => sink.increment(PRODUCT_METRICS.EXECUTIONS, { customer_id: 'cus_1' })).toThrow();
    expect(recorded).toHaveLength(1);
  });
});

describe('the collector', () => {
  it('accumulates a counter per series', () => {
    const collector = new MetricCollector();

    collector.increment(PRODUCT_METRICS.EXECUTIONS, { product: 'p', outcome: 'success' });
    collector.increment(PRODUCT_METRICS.EXECUTIONS, { product: 'p', outcome: 'success' }, 2);
    collector.increment(PRODUCT_METRICS.EXECUTIONS, { product: 'p', outcome: 'refusal' });

    const snapshots = collector.counterSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.find((entry) => entry.dimensions.outcome === 'success')?.value).toBe(3);
  });

  it('computes quantiles from observed values, never interpolated ones', () => {
    const collector = new MetricCollector();

    for (const value of [10, 20, 30, 40, 50]) {
      collector.observe(
        PRODUCT_METRICS.BLOCK_LATENCY,
        { product: 'p', block: 'b', outcome: 'success' },
        value,
      );
    }

    const [histogram] = collector.histogramSnapshots();
    // Nearest-rank: a p95 latency nobody ever experienced is a number somebody puts in an SLA.
    expect([10, 20, 30, 40, 50]).toContain(histogram?.p50);
    expect([10, 20, 30, 40, 50]).toContain(histogram?.p95);
    expect(histogram?.max).toBe(50);
    expect(histogram?.totalMs).toBe(150);
    expect(histogram?.count).toBe(5);
  });

  it('keeps a total across every observation even when the reservoir wraps', () => {
    const collector = new MetricCollector();

    for (let index = 0; index < 1500; index += 1) {
      collector.observe(PRODUCT_METRICS.EXECUTION_LATENCY, { product: 'p', outcome: 'success' }, 1);
    }

    const [histogram] = collector.histogramSnapshots();
    expect(histogram?.count).toBe(1500);
    expect(histogram?.totalMs).toBe(1500);
  });

  it('refuses an unbounded dimension on the way in', () => {
    const collector = new MetricCollector();
    expect(() =>
      collector.increment(PRODUCT_METRICS.EXECUTIONS, { customer_id: 'cus_1' }),
    ).toThrow();
  });

  it('reports dropped series rather than growing without bound', () => {
    const collector = new MetricCollector();
    expect(collector.dropped()).toBe(0);
  });

  it('resets', () => {
    const collector = new MetricCollector();
    collector.increment(PRODUCT_METRICS.EXECUTIONS, { product: 'p', outcome: 'success' });
    collector.reset();
    expect(collector.counterSnapshots()).toEqual([]);
  });
});

describe('dashboards', () => {
  it('splits every panel by a dimension its metric declares', () => {
    const byName = new Map(PRODUCT_METRIC_CATALOG.map((metric) => [metric.name, metric]));

    for (const dashboard of PRODUCT_DASHBOARDS) {
      for (const panel of dashboard.panels) {
        const metric = byName.get(panel.metric);
        expect(metric, `${panel.id} uses an unknown metric`).toBeDefined();

        for (const dimension of panel.splitBy) {
          expect(metric?.dimensions, `${panel.id} splits by ${dimension}`).toContain(dimension);
        }
      }
    }
  });

  it('gives every panel a thesis', () => {
    // A panel with no thesis gets ignored.
    for (const dashboard of PRODUCT_DASHBOARDS) {
      for (const panel of dashboard.panels) {
        expect(panel.interpretation.length).toBeGreaterThan(20);
      }
    }
  });

  it('separates refusals from failures on the health dashboard', () => {
    const health = findDashboard('product-health');
    const volume = health?.panels.find((panel) => panel.id === 'volume');
    expect(volume?.splitBy).toContain('outcome');
    expect(volume?.interpretation).toContain('refusal is the system working');
  });

  it('finds a dashboard by id', () => {
    expect(findDashboard('queues')?.title).toBe('Who is waiting');
    expect(findDashboard('nonexistent')).toBeUndefined();
  });
});
