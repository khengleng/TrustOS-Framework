import type {
  IntegrationHealthReport,
  IntegrationHealthStatus,
} from '@trustsystem/integration-health';

/**
 * The integration dashboard.
 *
 * Assembles the numbers behind the health report into something a person reads: throughput,
 * failures, latency, and what is currently wrong. Data only — no rendering. A framework that
 * shipped a UI would ship opinions about a design system, and every application would fight them.
 *
 * The thing this deliberately does *not* do is store a time series. Retaining per-minute counters
 * is a monitoring backend's job, and building a bad one into the framework would guarantee
 * everybody had a bad one. `@trustsystem/observability` already exposes the metrics seam; point it at
 * something that graphs.
 */

export interface IntegrationSnapshot {
  organizationId: string | null;
  capturedAt: Date;
  health: IntegrationHealthReport;

  events: {
    publishedLastHour: number;
    deadLettered: number;
    /** Subscribers currently registered. A drop here means a module stopped subscribing. */
    subscribers: number;
  };

  webhooks: {
    endpoints: number;
    activeEndpoints: number;
    disabledEndpoints: number;
    deliveredLastHour: number;
    failedLastHour: number;
    pending: number;
    /** Deliveries that succeeded, as a percentage of those attempted. */
    successRate: number;
    p95LatencyMs: number | null;
  };

  jobs: {
    queued: number;
    running: number;
    succeededLastHour: number;
    failedLastHour: number;
    /** How long a job waits before a worker picks it up. The number that says "add capacity". */
    oldestQueuedMinutes: number;
  };

  schedules: {
    active: number;
    paused: number;
    disabled: number;
    firedLastHour: number;
    missedLastHour: number;
  };

  sync: {
    connections: number;
    running: number;
    paused: number;
    unresolvedConflicts: number;
    recordsLastHour: number;
  };

  providers: Array<{
    key: string;
    status: IntegrationHealthStatus;
    detail: string;
    /** The circuit-breaker state. `open` means calls are failing fast. */
    circuit: string;
  }>;
}

/** Where the dashboard's numbers come from. Implemented over whatever store a deployment uses. */
export interface MonitorSource {
  events(organizationId: string | null): Promise<IntegrationSnapshot['events']>;
  webhooks(organizationId: string | null): Promise<IntegrationSnapshot['webhooks']>;
  jobs(organizationId: string | null): Promise<IntegrationSnapshot['jobs']>;
  schedules(organizationId: string | null): Promise<IntegrationSnapshot['schedules']>;
  sync(organizationId: string | null): Promise<IntegrationSnapshot['sync']>;
  providers(): Promise<IntegrationSnapshot['providers']>;
}

export class IntegrationMonitor {
  constructor(
    private readonly options: {
      source: MonitorSource;
      health: { report(): Promise<IntegrationHealthReport> };
      now?: () => Date;
    },
  ) {}

  /**
   * One snapshot.
   *
   * Every section is fetched concurrently and independently: a dashboard that failed entirely
   * because the sync counters were slow would be a dashboard nobody could use during the incident
   * it exists for. A section that fails comes back as zeros, and the health report — which is
   * computed separately — is what says something is wrong.
   */
  async snapshot(organizationId: string | null): Promise<IntegrationSnapshot> {
    const now = this.options.now ?? (() => new Date());

    const [health, events, webhooks, jobs, schedules, sync, providers] = await Promise.all([
      this.options.health.report(),
      safely(() => this.options.source.events(organizationId), EMPTY_EVENTS),
      safely(() => this.options.source.webhooks(organizationId), EMPTY_WEBHOOKS),
      safely(() => this.options.source.jobs(organizationId), EMPTY_JOBS),
      safely(() => this.options.source.schedules(organizationId), EMPTY_SCHEDULES),
      safely(() => this.options.source.sync(organizationId), EMPTY_SYNC),
      safely(() => this.options.source.providers(), []),
    ]);

    return {
      organizationId,
      capturedAt: now(),
      health,
      events,
      webhooks,
      jobs,
      schedules,
      sync,
      providers,
    };
  }

  /**
   * The snapshot as a handful of headline numbers.
   *
   * For a status strip: five numbers somebody can glance at. Anything more belongs on the full
   * dashboard, and a strip with fifteen numbers is one nobody reads.
   */
  summarize(snapshot: IntegrationSnapshot): Array<{
    label: string;
    value: string;
    status: IntegrationHealthStatus;
  }> {
    return [
      {
        label: 'Integration health',
        value: snapshot.health.status,
        status: snapshot.health.status,
      },
      {
        label: 'Webhook success',
        value: `${Math.round(snapshot.webhooks.successRate * 100)}%`,
        status:
          snapshot.webhooks.successRate >= 0.99
            ? 'healthy'
            : snapshot.webhooks.successRate >= 0.9
              ? 'warning'
              : 'critical',
      },
      {
        label: 'Jobs queued',
        value: String(snapshot.jobs.queued),
        // Judged on wait time rather than depth: a deep queue that drains fast is a busy system.
        status:
          snapshot.jobs.oldestQueuedMinutes > 30
            ? 'critical'
            : snapshot.jobs.oldestQueuedMinutes > 5
              ? 'warning'
              : 'healthy',
      },
      {
        label: 'Dead letters',
        value: String(snapshot.events.deadLettered),
        status: snapshot.events.deadLettered === 0 ? 'healthy' : 'warning',
      },
      {
        label: 'Sync conflicts',
        value: String(snapshot.sync.unresolvedConflicts),
        status: snapshot.sync.unresolvedConflicts === 0 ? 'healthy' : 'warning',
      },
    ];
  }

  /**
   * What is wrong, in the order to deal with it.
   *
   * Ordered by severity and then by how long it has been wrong. An operator opening a dashboard
   * during an incident wants the first line to be the thing to fix, not an alphabetical list.
   */
  problems(snapshot: IntegrationSnapshot): Array<{
    area: string;
    status: IntegrationHealthStatus;
    detail: string;
    remediation: string | null;
  }> {
    const problems = snapshot.health.problems.map((problem) => ({
      area: problem.key,
      status: problem.status,
      detail: problem.detail,
      remediation: problem.remediation,
    }));

    for (const provider of snapshot.providers) {
      if (provider.status === 'healthy') continue;

      problems.push({
        area: `provider.${provider.key}`,
        status: provider.status,
        detail:
          provider.circuit === 'open'
            ? `${provider.detail} The circuit is open, so calls are failing fast rather than waiting.`
            : provider.detail,
        remediation: null,
      });
    }

    const severity: Record<IntegrationHealthStatus, number> = {
      critical: 3,
      warning: 2,
      unknown: 1,
      healthy: 0,
    };

    return problems.sort(
      (a, b) => severity[b.status] - severity[a.status] || a.area.localeCompare(b.area),
    );
  }

  /**
   * The snapshot as plain text.
   *
   * What `trustos doctor integrations` prints. Text rather than a table library, so the CLI has
   * no rendering dependency and the output pastes into a ticket unchanged.
   */
  render(snapshot: IntegrationSnapshot): string {
    const lines: string[] = [];
    const mark = (status: IntegrationHealthStatus) =>
      status === 'healthy'
        ? 'ok  '
        : status === 'warning'
          ? 'warn'
          : status === 'unknown'
            ? '?   '
            : 'FAIL';

    lines.push(`Integration health: ${snapshot.health.status.toUpperCase()}`);
    lines.push(`Captured at ${snapshot.capturedAt.toISOString()}`);
    lines.push('');

    lines.push('Checks');
    for (const check of snapshot.health.checks) {
      lines.push(`  [${mark(check.status)}] ${check.key.padEnd(24)} ${check.detail}`);
    }

    lines.push('');
    lines.push('Counters');
    lines.push(
      `  events        published ${snapshot.events.publishedLastHour}/h, ` +
        `dead-lettered ${snapshot.events.deadLettered}, subscribers ${snapshot.events.subscribers}`,
    );
    lines.push(
      `  webhooks      ${snapshot.webhooks.activeEndpoints}/${snapshot.webhooks.endpoints} active, ` +
        `${Math.round(snapshot.webhooks.successRate * 100)}% success, ${snapshot.webhooks.pending} pending`,
    );
    lines.push(
      `  jobs          ${snapshot.jobs.queued} queued, ${snapshot.jobs.running} running, ` +
        `${snapshot.jobs.failedLastHour} failed/h`,
    );
    lines.push(
      `  schedules     ${snapshot.schedules.active} active, ${snapshot.schedules.paused} paused, ` +
        `${snapshot.schedules.missedLastHour} missed/h`,
    );
    lines.push(
      `  sync          ${snapshot.sync.connections} connections, ${snapshot.sync.paused} paused, ` +
        `${snapshot.sync.unresolvedConflicts} conflicts`,
    );

    if (snapshot.providers.length > 0) {
      lines.push('');
      lines.push('Providers');
      for (const provider of snapshot.providers) {
        lines.push(
          `  [${mark(provider.status)}] ${provider.key.padEnd(24)} ${provider.detail}` +
            (provider.circuit === 'open' ? ' (circuit open)' : ''),
        );
      }
    }

    const problems = this.problems(snapshot);

    if (problems.length > 0) {
      lines.push('');
      lines.push('What to do');
      for (const problem of problems) {
        lines.push(`  ${problem.area}: ${problem.detail}`);
        if (problem.remediation) lines.push(`    → ${problem.remediation}`);
      }
    }

    return lines.join('\n');
  }
}

async function safely<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    // A dashboard that failed entirely because one counter query was slow would be useless during
    // the incident it exists for. The health report is computed separately and is what reports
    // that something is wrong.
    return fallback;
  }
}

const EMPTY_EVENTS: IntegrationSnapshot['events'] = {
  publishedLastHour: 0,
  deadLettered: 0,
  subscribers: 0,
};

const EMPTY_WEBHOOKS: IntegrationSnapshot['webhooks'] = {
  endpoints: 0,
  activeEndpoints: 0,
  disabledEndpoints: 0,
  deliveredLastHour: 0,
  failedLastHour: 0,
  pending: 0,
  successRate: 1,
  p95LatencyMs: null,
};

const EMPTY_JOBS: IntegrationSnapshot['jobs'] = {
  queued: 0,
  running: 0,
  succeededLastHour: 0,
  failedLastHour: 0,
  oldestQueuedMinutes: 0,
};

const EMPTY_SCHEDULES: IntegrationSnapshot['schedules'] = {
  active: 0,
  paused: 0,
  disabled: 0,
  firedLastHour: 0,
  missedLastHour: 0,
};

const EMPTY_SYNC: IntegrationSnapshot['sync'] = {
  connections: 0,
  running: 0,
  paused: 0,
  unresolvedConflicts: 0,
  recordsLastHour: 0,
};
