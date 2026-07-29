export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  durationMs: number;
  /** Operator-facing detail. Must not contain credentials or connection strings. */
  detail?: string;
}

export interface HealthIndicator {
  name: string;
  /** A dependency marked non-critical degrades readiness without failing it. */
  critical?: boolean;
  check(): Promise<Omit<HealthCheckResult, 'name' | 'durationMs'>>;
}

export interface HealthReport {
  status: HealthStatus;
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  checks: HealthCheckResult[];
}

/**
 * Runs the registered readiness checks.
 *
 * Liveness and readiness are deliberately different questions:
 *
 *   GET /health  — "is this process alive?" Answers without touching any
 *                  dependency, so a database blip does not cause the platform
 *                  to kill and restart a perfectly healthy container.
 *   GET /ready   — "should traffic be routed here?" Checks dependencies, and
 *                  returns 503 when they are unavailable.
 *
 * Conflating them is how a brief database outage turns into a restart loop.
 */
export class HealthRegistry {
  private readonly indicators: HealthIndicator[] = [];
  private readonly startedAt = Date.now();

  constructor(
    private readonly meta: { service: string; version: string; environment: string },
    indicators: HealthIndicator[] = [],
  ) {
    this.indicators.push(...indicators);
  }

  register(indicator: HealthIndicator): void {
    this.indicators.push(indicator);
  }

  /** Liveness. No dependency is consulted. */
  liveness(): HealthReport {
    return {
      status: 'ok',
      service: this.meta.service,
      version: this.meta.version,
      environment: this.meta.environment,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks: [],
    };
  }

  /** Readiness. Every indicator runs; a critical failure fails the report. */
  async readiness(): Promise<HealthReport> {
    const checks = await Promise.all(
      this.indicators.map(async (indicator) => {
        const startedAt = Date.now();
        try {
          const result = await indicator.check();
          return { name: indicator.name, durationMs: Date.now() - startedAt, ...result };
        } catch (error) {
          return {
            name: indicator.name,
            status: 'down' as const,
            durationMs: Date.now() - startedAt,
            detail: error instanceof Error ? error.message : 'check threw',
          };
        }
      }),
    );

    return {
      status: aggregateStatus(checks, this.indicators),
      service: this.meta.service,
      version: this.meta.version,
      environment: this.meta.environment,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
    };
  }
}

function aggregateStatus(checks: HealthCheckResult[], indicators: HealthIndicator[]): HealthStatus {
  const criticalByName = new Map(
    indicators.map((indicator) => [indicator.name, indicator.critical !== false]),
  );

  let status: HealthStatus = 'ok';
  for (const check of checks) {
    if (check.status === 'ok') continue;
    const critical = criticalByName.get(check.name) ?? true;
    if (check.status === 'down' && critical) return 'down';
    status = 'degraded';
  }
  return status;
}

/** HTTP status for a report: only a hard failure takes the instance out of rotation. */
export function healthHttpStatus(report: HealthReport): number {
  return report.status === 'down' ? 503 : 200;
}

/** Builds a database readiness indicator from any client exposing a ping. */
export function databaseHealthIndicator(
  ping: () => Promise<{ ok: boolean; latencyMs: number; error?: string }>,
): HealthIndicator {
  return {
    name: 'database',
    critical: true,
    async check() {
      const result = await ping();
      return result.ok
        ? { status: 'ok', detail: `${result.latencyMs}ms` }
        : // The driver's error text can contain the connection string, so it is
          // summarized rather than echoed. The full error is in the logs.
          { status: 'down', detail: 'database unreachable' };
    },
  };
}
