import type { PermissionCheck } from './permissions';

/**
 * Dashboards.
 *
 * A dashboard is a layout of widgets, each of which names where its number comes from. The SDK
 * does not fetch anything and does not aggregate anything — it describes, filters by permission,
 * and formats.
 *
 * The reason it stops there: every real dashboard number is a query somebody has to write
 * against a schema only the template knows. An SDK that tried to own the aggregation would need
 * a query language, and the template would end up expressing "revenue this month" in it instead
 * of in SQL, badly.
 *
 * What the SDK *does* own is the part every dashboard gets wrong: a widget the actor may not see
 * must not be requested. Widgets carry permissions and `visibleWidgets` is meant to run on the
 * server, before the numbers are computed — otherwise the total is calculated, sent, and hidden
 * in the browser, which is a disclosure with a spinner in front of it.
 */

export type WidgetKind = 'metric' | 'chart' | 'table' | 'list' | 'status';

export type TrendDirection = 'up' | 'down' | 'flat';

export interface DashboardWidget {
  key: string;
  title: string;
  kind: WidgetKind;
  description?: string;
  /** Permission required. See the header: filter before computing, not after. */
  permission?: string;
  /** Grid columns out of 12. Defaults to 3 for a metric, 6 for anything else. */
  span?: number;
  /** API path this widget's data comes from. */
  endpoint?: string;
  /** For `chart`: which chart specification to render. See `charts.ts`. */
  chart?: string;
}

export interface DashboardDefinition {
  key: string;
  title: string;
  description?: string;
  widgets: DashboardWidget[];
  permission?: string;
}

/** A computed metric, as an endpoint returns it. */
export interface MetricValue {
  key: string;
  label: string;
  /** Pre-formatted. A number formatted in the browser disagrees with the same number in a CSV. */
  value: string;
  /** Change against the comparison period, as a formatted string. */
  delta?: string;
  direction?: TrendDirection;
  /**
   * Whether `up` is good.
   *
   * Not cosmetic. On revenue, up is green; on failed logins, up is red — and a dashboard that
   * paints every increase green trains people to read rising fraud as success.
   */
  higherIsBetter?: boolean;
  hint?: string;
}

export function defaultSpan(widget: DashboardWidget): number {
  return widget.span ?? (widget.kind === 'metric' ? 3 : 6);
}

export function visibleWidgets(
  dashboard: DashboardDefinition,
  can: PermissionCheck,
): DashboardWidget[] {
  return dashboard.widgets.filter((widget) => !widget.permission || can(widget.permission));
}

/** Whether the actor may open the dashboard at all. */
export function canOpenDashboard(dashboard: DashboardDefinition, can: PermissionCheck): boolean {
  if (dashboard.permission && !can(dashboard.permission)) return false;
  return visibleWidgets(dashboard, can).length > 0;
}

/**
 * Which way a change should be read.
 *
 * Returns `positive`, `negative` or `neutral` — a judgement, not a direction, so the renderer
 * picks a colour without re-deciding what "good" means per widget.
 */
export function interpretTrend(metric: MetricValue): 'positive' | 'negative' | 'neutral' {
  if (!metric.direction || metric.direction === 'flat') return 'neutral';

  const higherIsBetter = metric.higherIsBetter ?? true;
  const isUp = metric.direction === 'up';

  return isUp === higherIsBetter ? 'positive' : 'negative';
}
