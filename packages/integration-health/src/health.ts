import type { ProviderHealthStatus } from '@trustsystem/provider-sdk';

/**
 * Integration health.
 *
 * One question — "is the integration layer working?" — answered as `healthy`, `warning` or
 * `critical`, from signals the individual packages already produce.
 *
 * The design decision that matters is the **aggregation rule: the worst wins.** A report that
 * averaged its inputs would show "mostly healthy" while the payment webhook has been dead for
 * six hours, and a dashboard that is green during an outage is worse than no dashboard.
 *
 * The second decision: **a check that cannot answer is `warning`, not `healthy`.** "I do not
 * know" is not "fine". A health endpoint that reports green because its own probe failed is the
 * exact failure mode this is meant to catch.
 */

export type IntegrationHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

export const HEALTH_SEVERITY: Record<IntegrationHealthStatus, number> = {
  healthy: 0,
  // Above healthy, below critical: an unanswered check is a real signal, but not the same signal
  // as a confirmed failure.
  unknown: 1,
  warning: 2,
  critical: 3,
};

export interface IntegrationCheck {
  /** Stable, so a dashboard can track one check over time. `webhooks.delivery`, `jobs.queue`. */
  key: string;
  /** What this checks, in a sentence. Shown next to the status. */
  description: string;
  run(): Promise<IntegrationCheckResult>;
}

export interface IntegrationCheckResult {
  status: IntegrationHealthStatus;
  /** One sentence an operator can act on. "412 deliveries pending, oldest 4h" beats "degraded". */
  detail: string;
  /** Numbers behind the verdict, for a graph. */
  metrics?: Record<string, number>;
  /** What to do. Rendered in `trustos doctor integrations`. */
  remediation?: string;
}

export interface IntegrationHealthReport {
  status: IntegrationHealthStatus;
  checkedAt: Date;
  durationMs: number;
  checks: Array<IntegrationCheckResult & { key: string; description: string; durationMs: number }>;
  /** The checks that are not healthy, worst first. What an operator reads. */
  problems: Array<{
    key: string;
    status: IntegrationHealthStatus;
    detail: string;
    remediation: string | null;
  }>;
}

/**
 * Runs the checks and aggregates.
 *
 * Concurrently and with a per-check timeout: a health endpoint is scraped every few seconds, and
 * one check that hangs must not make the endpoint hang. A timed-out check is `warning` with the
 * timeout named, because a check that cannot answer within its budget is itself a signal.
 */
export class IntegrationHealthService {
  private readonly checks = new Map<string, IntegrationCheck>();

  constructor(private readonly options: { checkTimeoutMs?: number; now?: () => Date } = {}) {}

  register(check: IntegrationCheck): this {
    this.checks.set(check.key, check);
    return this;
  }

  registerAll(checks: IntegrationCheck[]): this {
    for (const check of checks) this.register(check);
    return this;
  }

  async report(): Promise<IntegrationHealthReport> {
    const now = this.options.now ?? (() => new Date());
    const timeoutMs = this.options.checkTimeoutMs ?? 5000;
    const startedAt = Date.now();

    const results = await Promise.all(
      [...this.checks.values()].map(async (check) => {
        const checkStartedAt = Date.now();

        try {
          const result = await withTimeout(check.run(), timeoutMs, check.key);
          return {
            ...result,
            key: check.key,
            description: check.description,
            durationMs: Date.now() - checkStartedAt,
          };
        } catch (error) {
          // A throwing or hanging check reports `warning` rather than being omitted. Omitting it
          // would make the report green by virtue of the check being broken.
          return {
            key: check.key,
            description: check.description,
            status: 'warning' as const,
            detail: `The check did not complete: ${
              error instanceof Error ? error.message : String(error)
            }`,
            durationMs: Date.now() - checkStartedAt,
          };
        }
      }),
    );

    const status = results.reduce<IntegrationHealthStatus>(
      // The worst wins. Averaging would show "mostly healthy" during an outage.
      (worst, result) =>
        HEALTH_SEVERITY[result.status] > HEALTH_SEVERITY[worst] ? result.status : worst,
      'healthy',
    );

    return {
      status,
      checkedAt: now(),
      durationMs: Date.now() - startedAt,
      checks: results.sort((a, b) => a.key.localeCompare(b.key)),
      problems: results
        .filter((result) => result.status !== 'healthy')
        .sort((a, b) => HEALTH_SEVERITY[b.status] - HEALTH_SEVERITY[a.status])
        .map((result) => ({
          key: result.key,
          status: result.status,
          detail: result.detail,
          remediation: result.remediation ?? null,
        })),
    };
  }

  keys(): string[] {
    return [...this.checks.keys()].sort();
  }
}

/**
 * The HTTP status for a report.
 *
 * 200 for healthy *and* for warning; 503 only for critical. A load balancer reading this must not
 * take a pod out of rotation because a webhook queue is backing up — the pod is serving requests
 * fine, and removing it makes the backlog worse.
 */
export function healthHttpStatus(report: IntegrationHealthReport): number {
  return report.status === 'critical' ? 503 : 200;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, key: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The "${key}" check exceeded its ${ms}ms budget.`)),
          ms,
        );
      }),
    ]);
  } finally {
    // Cleared, so a slow check does not hold the event loop open after the race resolves.
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------------- *
 * The checks the framework ships
 * ------------------------------------------------------------------------- */

/**
 * Webhook delivery health.
 *
 * The thresholds are about *age*, not count. A thousand deliveries queued in the last minute is a
 * busy system; ten queued for six hours is a broken one, and a count-based threshold cannot tell
 * them apart.
 */
export function webhookDeliveryCheck(source: {
  pendingCount(): Promise<number>;
  oldestPendingAgeMs(): Promise<number | null>;
  exhaustedInLastHour(): Promise<number>;
  disabledEndpoints(): Promise<number>;
}): IntegrationCheck {
  return {
    key: 'webhooks.delivery',
    description: 'Webhook deliveries are being sent and are not backing up.',
    async run(): Promise<IntegrationCheckResult> {
      const [pending, oldestAgeMs, exhausted, disabled] = await Promise.all([
        source.pendingCount(),
        source.oldestPendingAgeMs(),
        source.exhaustedInLastHour(),
        source.disabledEndpoints(),
      ]);

      const metrics = {
        pending,
        oldestPendingMinutes: oldestAgeMs === null ? 0 : Math.round(oldestAgeMs / 60_000),
        exhaustedLastHour: exhausted,
        disabledEndpoints: disabled,
      };

      if (oldestAgeMs !== null && oldestAgeMs > 60 * 60_000) {
        return {
          status: 'critical',
          detail: `${pending} deliveries pending; the oldest has waited ${metrics.oldestPendingMinutes} minutes.`,
          metrics,
          remediation:
            'The delivery worker is probably not running. Check that it is started, and look at ' +
            'the endpoint failure counts.',
        };
      }

      if (oldestAgeMs !== null && oldestAgeMs > 10 * 60_000) {
        return {
          status: 'warning',
          detail: `${pending} deliveries pending; the oldest has waited ${metrics.oldestPendingMinutes} minutes.`,
          metrics,
          remediation: 'Deliveries are behind. If this does not clear, add worker capacity.',
        };
      }

      if (exhausted > 0 || disabled > 0) {
        return {
          status: 'warning',
          detail: `${exhausted} deliveries gave up in the last hour; ${disabled} endpoints are disabled.`,
          metrics,
          remediation:
            'Look at the dead deliveries and the endpoints that were disabled. Once the receiver ' +
            'is fixed, re-enable and replay.',
        };
      }

      return { status: 'healthy', detail: `${pending} pending, nothing overdue.`, metrics };
    },
  };
}

/** Job queue health. Same reasoning: age, not depth. */
export function jobQueueCheck(source: {
  queuedCount(): Promise<number>;
  runningCount(): Promise<number>;
  oldestQueuedAgeMs(): Promise<number | null>;
  failedInLastHour(): Promise<number>;
}): IntegrationCheck {
  return {
    key: 'jobs.queue',
    description: 'Background jobs are being picked up and completed.',
    async run(): Promise<IntegrationCheckResult> {
      const [queued, running, oldestAgeMs, failed] = await Promise.all([
        source.queuedCount(),
        source.runningCount(),
        source.oldestQueuedAgeMs(),
        source.failedInLastHour(),
      ]);

      const metrics = {
        queued,
        running,
        oldestQueuedMinutes: oldestAgeMs === null ? 0 : Math.round(oldestAgeMs / 60_000),
        failedLastHour: failed,
      };

      /*
       * Work waiting with nothing running is the specific shape of "no worker is alive".
       *
       * A deep queue with workers running is a busy system. A deep queue with zero running is a
       * deployment where the worker process was never started — which is easy to do and produces
       * no error anywhere.
       */
      if (queued > 0 && running === 0 && oldestAgeMs !== null && oldestAgeMs > 5 * 60_000) {
        return {
          status: 'critical',
          detail: `${queued} jobs queued, none running, oldest waiting ${metrics.oldestQueuedMinutes} minutes.`,
          metrics,
          remediation:
            'No worker appears to be running. Check that the job worker process started.',
        };
      }

      if (oldestAgeMs !== null && oldestAgeMs > 30 * 60_000) {
        return {
          status: 'warning',
          detail: `Jobs are behind: the oldest has waited ${metrics.oldestQueuedMinutes} minutes.`,
          metrics,
          remediation: 'Add worker capacity, or check for a job type that is blocking the queue.',
        };
      }

      if (failed > 10) {
        return {
          status: 'warning',
          detail: `${failed} jobs failed permanently in the last hour.`,
          metrics,
          remediation: 'Look at the failed jobs; they share a cause more often than not.',
        };
      }

      return { status: 'healthy', detail: `${queued} queued, ${running} running.`, metrics };
    },
  };
}

/** Scheduler health. A scheduler that has stopped ticking is silent, which is the problem. */
export function schedulerCheck(source: {
  activeSchedules(): Promise<number>;
  overdueSchedules(): Promise<number>;
  disabledSchedules(): Promise<number>;
  lastTickAgeMs(): Promise<number | null>;
}): IntegrationCheck {
  return {
    key: 'scheduler.ticks',
    description: 'The scheduler is running and schedules are firing on time.',
    async run(): Promise<IntegrationCheckResult> {
      const [active, overdue, disabled, lastTickAgeMs] = await Promise.all([
        source.activeSchedules(),
        source.overdueSchedules(),
        source.disabledSchedules(),
        source.lastTickAgeMs(),
      ]);

      const metrics = {
        active,
        overdue,
        disabled,
        lastTickMinutes: lastTickAgeMs === null ? -1 : Math.round(lastTickAgeMs / 60_000),
      };

      // A scheduler that has stopped produces no error and no log line. The absence of a tick is
      // the only evidence there is.
      if (active > 0 && lastTickAgeMs !== null && lastTickAgeMs > 15 * 60_000) {
        return {
          status: 'critical',
          detail: `The scheduler has not ticked for ${metrics.lastTickMinutes} minutes.`,
          metrics,
          remediation: 'The scheduler is not running. Check that it started and has not thrown.',
        };
      }

      if (overdue > 0) {
        return {
          status: 'warning',
          detail: `${overdue} schedules are past their due time.`,
          metrics,
          remediation: 'Check whether their job types are still registered.',
        };
      }

      if (disabled > 0) {
        return {
          status: 'warning',
          detail: `${disabled} schedules have been disabled automatically after repeated failures.`,
          metrics,
          remediation: 'Look at each schedule’s last error, fix it, and re-enable.',
        };
      }

      return { status: 'healthy', detail: `${active} active schedules, none overdue.`, metrics };
    },
  };
}

/** Dead letters. Any unreplayed dead letter is work that did not happen. */
export function deadLetterCheck(source: {
  unreplayedCount(): Promise<number>;
  oldestAgeMs(): Promise<number | null>;
}): IntegrationCheck {
  return {
    key: 'events.dead_letters',
    description: 'No events have failed permanently and been left unhandled.',
    async run(): Promise<IntegrationCheckResult> {
      const [count, oldestAgeMs] = await Promise.all([
        source.unreplayedCount(),
        source.oldestAgeMs(),
      ]);

      const metrics = {
        unreplayed: count,
        oldestHours: oldestAgeMs === null ? 0 : Math.round(oldestAgeMs / 3_600_000),
      };

      if (count === 0) return { status: 'healthy', detail: 'No unreplayed dead letters.', metrics };

      // Warning rather than critical: a dead letter is work that did not happen, but it is
      // recoverable by replay, and the system is otherwise serving requests.
      return {
        status: count > 100 || metrics.oldestHours > 24 ? 'critical' : 'warning',
        detail: `${count} dead letters are unreplayed; the oldest is ${metrics.oldestHours} hours old.`,
        metrics,
        remediation:
          'Each one is an event a handler never processed. Fix the handler, then replay them.',
      };
    },
  };
}

/** Provider adapters. Reuses whatever each provider's own `health()` reports. */
export function providerCheck(source: {
  healthAll(): Promise<
    Array<{ key: string; health: { status: ProviderHealthStatus; detail: string } }>
  >;
}): IntegrationCheck {
  return {
    key: 'providers.health',
    description: 'Every registered provider adapter is reachable.',
    async run(): Promise<IntegrationCheckResult> {
      const providers = await source.healthAll();

      const critical = providers.filter((entry) => entry.health.status === 'critical');
      const warning = providers.filter((entry) => entry.health.status === 'warning');

      const metrics = {
        total: providers.length,
        healthy: providers.filter((entry) => entry.health.status === 'healthy').length,
        warning: warning.length,
        critical: critical.length,
      };

      if (critical.length > 0) {
        return {
          status: 'critical',
          detail: `${critical.length} providers are unavailable: ${critical
            .map((entry) => `${entry.key} (${entry.health.detail})`)
            .join('; ')}`,
          metrics,
          remediation: 'Check each provider’s configuration and whether its downstream is up.',
        };
      }

      if (warning.length > 0) {
        return {
          status: 'warning',
          detail: `${warning.length} providers are degraded: ${warning.map((entry) => entry.key).join(', ')}`,
          metrics,
        };
      }

      return { status: 'healthy', detail: `${providers.length} providers healthy.`, metrics };
    },
  };
}

/** Synchronization. A paused connection is not syncing, and nothing else will say so. */
export function syncCheck(source: {
  pausedConnections(): Promise<number>;
  failedConnections(): Promise<number>;
  unresolvedConflicts(): Promise<number>;
  stalestSyncAgeMs(): Promise<number | null>;
}): IntegrationCheck {
  return {
    key: 'sync.connections',
    description: 'Synchronization connections are running and not accumulating conflicts.',
    async run(): Promise<IntegrationCheckResult> {
      const [paused, failed, conflicts, stalestAgeMs] = await Promise.all([
        source.pausedConnections(),
        source.failedConnections(),
        source.unresolvedConflicts(),
        source.stalestSyncAgeMs(),
      ]);

      const metrics = {
        paused,
        failed,
        unresolvedConflicts: conflicts,
        stalestHours: stalestAgeMs === null ? 0 : Math.round(stalestAgeMs / 3_600_000),
      };

      if (paused > 0) {
        return {
          status: 'critical',
          detail: `${paused} sync connections are paused and are not syncing.`,
          metrics,
          remediation: 'Read the last error on each, fix the cause, and resume it.',
        };
      }

      if (failed > 0 || metrics.stalestHours > 24) {
        return {
          status: 'warning',
          detail: `${failed} connections failed their last run; the stalest synced ${metrics.stalestHours} hours ago.`,
          metrics,
        };
      }

      if (conflicts > 0) {
        return {
          status: 'warning',
          detail: `${conflicts} sync conflicts are waiting for a decision.`,
          metrics,
          remediation: 'Each one is a record two systems disagree about. Resolve them.',
        };
      }

      return { status: 'healthy', detail: 'All sync connections are up to date.', metrics };
    },
  };
}
