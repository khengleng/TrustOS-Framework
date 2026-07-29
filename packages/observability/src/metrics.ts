/**
 * Metrics hooks.
 *
 * The framework does not ship a metrics backend — no Prometheus endpoint, no
 * StatsD client, no scrape config. What it ships is the *seam*: a small
 * interface the application already calls, so adopting a backend later is one
 * adapter rather than an instrumentation project.
 */

export type MetricLabels = Record<string, string | number | boolean | null | undefined>;

export interface MetricsRecorder {
  /** Monotonic counter, e.g. requests, errors, logins. */
  increment(name: string, value?: number, labels?: MetricLabels): void;
  /** Distribution, e.g. request duration in milliseconds. */
  observe(name: string, value: number, labels?: MetricLabels): void;
  /** Point-in-time value, e.g. active connections. */
  gauge(name: string, value: number, labels?: MetricLabels): void;
}

export const METRICS = {
  HTTP_REQUESTS: 'http.server.requests',
  HTTP_DURATION_MS: 'http.server.duration_ms',
  HTTP_ERRORS: 'http.server.errors',
  AUTH_LOGIN_SUCCESS: 'auth.login.success',
  AUTH_LOGIN_FAILURE: 'auth.login.failure',
  AUTH_TOKEN_REUSE: 'auth.token.reuse_detected',
  TENANT_ISOLATION_BLOCKED: 'tenancy.cross_organization.blocked',
} as const;

/** Default. Costs one function call and does nothing. */
export class NoopMetricsRecorder implements MetricsRecorder {
  increment(): void {}
  observe(): void {}
  gauge(): void {}
}

/** Test double that keeps everything it was given. */
export class InMemoryMetricsRecorder implements MetricsRecorder {
  readonly entries: Array<{
    kind: 'increment' | 'observe' | 'gauge';
    name: string;
    value: number;
    labels: MetricLabels;
  }> = [];

  increment(name: string, value = 1, labels: MetricLabels = {}): void {
    this.entries.push({ kind: 'increment', name, value, labels });
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    this.entries.push({ kind: 'observe', name, value, labels });
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.entries.push({ kind: 'gauge', name, value, labels });
  }

  valuesFor(name: string): number[] {
    return this.entries.filter((entry) => entry.name === name).map((entry) => entry.value);
  }
}

export interface HttpRequestMetric {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
}

/**
 * Records the standard HTTP metrics for one finished request.
 *
 * Wire it to the single `onComplete` hook exposed by
 * `requestContextMiddleware` in @trustos/logging.
 *
 * Note the label set: method, route and status class only. Labelling by raw
 * path or by organization id multiplies cardinality by the number of ids in
 * the system, which is how a metrics bill becomes an incident.
 */
export function recordHttpRequest(recorder: MetricsRecorder, metric: HttpRequestMetric): void {
  const labels: MetricLabels = {
    method: metric.method,
    route: normalizeRoute(metric.path),
    status_class: `${Math.floor(metric.statusCode / 100)}xx`,
  };

  recorder.increment(METRICS.HTTP_REQUESTS, 1, labels);
  recorder.observe(METRICS.HTTP_DURATION_MS, metric.durationMs, labels);
  if (metric.statusCode >= 500) recorder.increment(METRICS.HTTP_ERRORS, 1, labels);
}

/**
 * Collapses identifiers in a path so `/organizations/org_abc/members` and
 * `/organizations/org_xyz/members` share one time series.
 */
export function normalizeRoute(path: string): string {
  const [withoutQuery] = path.split('?');
  return (withoutQuery ?? '')
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^[0-9]+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) return ':id';
      if (/^(c[a-z0-9]{20,}|[a-z]+_[A-Za-z0-9]{6,})$/.test(segment)) return ':id';
      return segment;
    })
    .join('/');
}
