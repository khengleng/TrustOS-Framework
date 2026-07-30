/**
 * Charts.
 *
 * A specification and the shaping that goes with it — no rendering, no charting library. A
 * template's admin picks its own renderer; what it must not pick per screen is what an empty
 * series looks like, or whether a gap in a time series means zero.
 *
 * That second question is the reason this file exists. A daily revenue chart with no orders on
 * Sunday has two honest renderings: a line dropping to zero, or a line skipping the day. They
 * mean different things — "we sold nothing" and "we have no data" — and the wrong one turns a
 * closed shop into a crisis, or an outage into a quiet weekend. `fillGaps` makes the choice
 * explicit and records it in the spec, so a reviewer can see which one the chart claims.
 */

export type ChartKind = 'line' | 'bar' | 'stackedBar' | 'area' | 'pie' | 'donut';

export interface ChartPoint {
  /** Category or timestamp. ISO 8601 for time series — never a locale-formatted string. */
  x: string;
  y: number;
  /** Overrides the series label for this point. For a pie slice. */
  label?: string;
}

export interface ChartSeries {
  key: string;
  label: string;
  points: ChartPoint[];
  /** Semantic role, mapped to a colour by the renderer. Never a hex value in a spec. */
  tone?: 'default' | 'positive' | 'negative' | 'warning' | 'neutral';
}

export interface ChartSpec {
  key: string;
  title: string;
  kind: ChartKind;
  series: ChartSeries[];
  xLabel?: string;
  yLabel?: string;
  /** Formatting hint for the y axis and tooltips. */
  valueFormat?: 'number' | 'money' | 'percent' | 'duration';
  /** For `money`: the ISO currency the values are in. Money without a currency is a number. */
  currency?: string;
  /**
   * Whether missing x values mean zero.
   *
   * See the header — this is a claim about the data, not a rendering preference.
   */
  fillGaps?: boolean;
  /** Shown in place of the chart when every series is empty. */
  emptyHint?: string;
}

export function isEmpty(spec: ChartSpec): boolean {
  return spec.series.every((series) => series.points.length === 0);
}

/**
 * Inserts zero points for missing x values across every series.
 *
 * Only call this when zero is the truth. Applied to a chart whose data simply has not arrived
 * yet, it draws a confident line along the bottom that says the business stopped.
 */
export function fillSeriesGaps(spec: ChartSpec, expectedX: string[]): ChartSpec {
  if (!spec.fillGaps) return spec;

  return {
    ...spec,
    series: spec.series.map((series) => {
      const byX = new Map(series.points.map((point) => [point.x, point]));
      return { ...series, points: expectedX.map((x) => byX.get(x) ?? { x, y: 0 }) };
    }),
  };
}

/**
 * Consecutive dates covering a range, as ISO `YYYY-MM-DD`.
 *
 * UTC throughout. A chart bucketed in local time shifts every point when the server moves, and a
 * Cambodian day boundary computed in UTC+0 puts the evening's takings on the wrong date — so a
 * template showing local days must convert *before* bucketing and pass the results here.
 */
export function dailyRange(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0),
  );
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 0, 0, 0, 0);

  // Bounded at roughly three years, so a bad date range cannot allocate without limit.
  for (let guard = 0; cursor.getTime() <= end && guard < 1200; guard += 1) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

/** Groups rows into a series by a key function. The aggregation most dashboards actually need. */
export function toSeries<T>(
  rows: T[],
  options: {
    key: string;
    label: string;
    x: (row: T) => string;
    y: (row: T) => number;
    tone?: ChartSeries['tone'];
  },
): ChartSeries {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const x = options.x(row);
    totals.set(x, (totals.get(x) ?? 0) + options.y(row));
  }

  return {
    key: options.key,
    label: options.label,
    tone: options.tone,
    points: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([x, y]) => ({ x, y })),
  };
}
