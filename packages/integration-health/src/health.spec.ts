import { describe, expect, it } from 'vitest';
import {
  IntegrationHealthService,
  deadLetterCheck,
  healthHttpStatus,
  jobQueueCheck,
  providerCheck,
  schedulerCheck,
  syncCheck,
  webhookDeliveryCheck,
  type IntegrationCheck,
  type IntegrationHealthStatus,
} from './health';

function check(key: string, status: IntegrationHealthStatus): IntegrationCheck {
  return {
    key,
    description: `The ${key} check.`,
    run: async () => ({ status, detail: `${key} is ${status}` }),
  };
}

describe('aggregation', () => {
  it('is healthy when every check is', async () => {
    const service = new IntegrationHealthService().registerAll([
      check('a', 'healthy'),
      check('b', 'healthy'),
    ]);

    expect((await service.report()).status).toBe('healthy');
  });

  it('takes the worst status, not an average', async () => {
    // A report that averaged would show "mostly healthy" while the payment webhook has been dead
    // for six hours, and a dashboard that is green during an outage is worse than no dashboard.
    const service = new IntegrationHealthService().registerAll([
      check('a', 'healthy'),
      check('b', 'healthy'),
      check('c', 'healthy'),
      check('d', 'critical'),
    ]);

    expect((await service.report()).status).toBe('critical');
  });

  it.each([
    [['healthy', 'warning'], 'warning'],
    [['warning', 'critical'], 'critical'],
    [['healthy', 'unknown'], 'unknown'],
    [['unknown', 'warning'], 'warning'],
  ] as const)('%j aggregates to %s', async (statuses, expected) => {
    const service = new IntegrationHealthService().registerAll(
      statuses.map((status, index) => check(`c${index}`, status)),
    );

    expect((await service.report()).status).toBe(expected);
  });

  it('ranks unknown above healthy but below warning', async () => {
    // "I do not know" is not "fine", and it is not the same as a confirmed failure either.
    const service = new IntegrationHealthService().registerAll([
      check('a', 'unknown'),
      check('b', 'healthy'),
    ]);

    expect((await service.report()).status).toBe('unknown');
  });

  it('is healthy with no checks registered', async () => {
    expect((await new IntegrationHealthService().report()).status).toBe('healthy');
  });
});

describe('a check that cannot answer', () => {
  it('is a warning rather than being omitted', async () => {
    // Omitting it would make the report green by virtue of the check being broken — the exact
    // failure mode a health endpoint exists to catch.
    const service = new IntegrationHealthService().register({
      key: 'broken',
      description: 'A check that throws.',
      run: async () => {
        throw new Error('the query failed');
      },
    });

    const report = await service.report();

    expect(report.status).toBe('warning');
    expect(report.checks[0]?.detail).toMatch(/the query failed/);
  });

  it('times out rather than hanging the endpoint', async () => {
    // A health endpoint is scraped every few seconds; one hanging check must not hang it.
    const service = new IntegrationHealthService({ checkTimeoutMs: 30 }).register({
      key: 'slow',
      description: 'A check that never returns.',
      run: () => new Promise(() => {}),
    });

    const startedAt = Date.now();
    const report = await service.report();

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(report.status).toBe('warning');
    expect(report.checks[0]?.detail).toMatch(/exceeded its 30ms budget/);
  });

  it('runs checks concurrently rather than serially', async () => {
    const slow = (key: string): IntegrationCheck => ({
      key,
      description: 'slow',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { status: 'healthy' as const, detail: 'fine' };
      },
    });

    const service = new IntegrationHealthService().registerAll([slow('a'), slow('b'), slow('c')]);

    const startedAt = Date.now();
    await service.report();

    expect(Date.now() - startedAt).toBeLessThan(80);
  });
});

describe('the report', () => {
  it('lists problems worst first', async () => {
    const service = new IntegrationHealthService().registerAll([
      check('warn_one', 'warning'),
      check('critical_one', 'critical'),
      check('fine', 'healthy'),
    ]);

    const report = await service.report();

    expect(report.problems.map((problem) => problem.key)).toEqual(['critical_one', 'warn_one']);
  });

  it('omits healthy checks from the problem list', async () => {
    const service = new IntegrationHealthService().registerAll([check('fine', 'healthy')]);

    expect((await service.report()).problems).toEqual([]);
    expect((await service.report()).checks).toHaveLength(1);
  });
});

describe('the HTTP status', () => {
  it('is 503 only when critical', async () => {
    // A load balancer must not take a pod out of rotation because a webhook queue is backing up:
    // the pod is serving fine, and removing it makes the backlog worse.
    const critical = await new IntegrationHealthService().register(check('a', 'critical')).report();
    const warning = await new IntegrationHealthService().register(check('a', 'warning')).report();
    const healthy = await new IntegrationHealthService().register(check('a', 'healthy')).report();

    expect(healthHttpStatus(critical)).toBe(503);
    expect(healthHttpStatus(warning)).toBe(200);
    expect(healthHttpStatus(healthy)).toBe(200);
  });
});

describe('the webhook check', () => {
  const source = (overrides: Partial<Record<string, number | null>> = {}) => ({
    pendingCount: async () => (overrides.pending as number) ?? 0,
    oldestPendingAgeMs: async () => (overrides.oldestAge as number | null) ?? null,
    exhaustedInLastHour: async () => (overrides.exhausted as number) ?? 0,
    disabledEndpoints: async () => (overrides.disabled as number) ?? 0,
  });

  it('is healthy with nothing overdue', async () => {
    expect((await webhookDeliveryCheck(source()).run()).status).toBe('healthy');
  });

  it('judges on age rather than count', async () => {
    // A thousand queued in the last minute is a busy system; ten queued for six hours is broken,
    // and a count threshold cannot tell them apart.
    const busy = await webhookDeliveryCheck(source({ pending: 1000, oldestAge: 30_000 })).run();
    const broken = await webhookDeliveryCheck(
      source({ pending: 10, oldestAge: 6 * 3_600_000 }),
    ).run();

    expect(busy.status).toBe('healthy');
    expect(broken.status).toBe('critical');
  });

  it('warns when deliveries are moderately behind', async () => {
    const result = await webhookDeliveryCheck(
      source({ pending: 50, oldestAge: 15 * 60_000 }),
    ).run();

    expect(result.status).toBe('warning');
  });

  it('warns about disabled endpoints and says what to do', async () => {
    const result = await webhookDeliveryCheck(source({ disabled: 2, exhausted: 5 })).run();

    expect(result.status).toBe('warning');
    expect(result.remediation).toMatch(/re-enable and replay/);
  });

  it('reports numbers a graph can use', async () => {
    const result = await webhookDeliveryCheck(source({ pending: 3, oldestAge: 120_000 })).run();

    expect(result.metrics).toMatchObject({ pending: 3, oldestPendingMinutes: 2 });
  });
});

describe('the job queue check', () => {
  const source = (overrides: Record<string, number | null> = {}) => ({
    queuedCount: async () => (overrides.queued as number) ?? 0,
    runningCount: async () => (overrides.running as number) ?? 0,
    oldestQueuedAgeMs: async () => (overrides.oldestAge as number | null) ?? null,
    failedInLastHour: async () => (overrides.failed as number) ?? 0,
  });

  it('detects the specific shape of "no worker is running"', async () => {
    // A deep queue with workers running is a busy system; a deep queue with zero running is a
    // deployment where the worker was never started, which produces no error anywhere.
    const result = await jobQueueCheck(
      source({ queued: 40, running: 0, oldestAge: 10 * 60_000 }),
    ).run();

    expect(result.status).toBe('critical');
    expect(result.remediation).toMatch(/worker process started/);
  });

  it('is healthy when a deep queue is being worked', async () => {
    const result = await jobQueueCheck(
      source({ queued: 400, running: 8, oldestAge: 20_000 }),
    ).run();

    expect(result.status).toBe('healthy');
  });

  it('warns when jobs are waiting a long time', async () => {
    const result = await jobQueueCheck(
      source({ queued: 10, running: 2, oldestAge: 45 * 60_000 }),
    ).run();

    expect(result.status).toBe('warning');
  });

  it('warns on a burst of permanent failures', async () => {
    expect((await jobQueueCheck(source({ failed: 25 })).run()).status).toBe('warning');
  });
});

describe('the scheduler check', () => {
  const source = (overrides: Record<string, number | null> = {}) => ({
    activeSchedules: async () => (overrides.active as number) ?? 0,
    overdueSchedules: async () => (overrides.overdue as number) ?? 0,
    disabledSchedules: async () => (overrides.disabled as number) ?? 0,
    lastTickAgeMs: async () => (overrides.lastTick as number | null) ?? 0,
  });

  it('is critical when the scheduler has stopped ticking', async () => {
    // A stopped scheduler produces no error and no log line. The absence of a tick is the only
    // evidence there is.
    const result = await schedulerCheck(source({ active: 5, lastTick: 20 * 60_000 })).run();

    expect(result.status).toBe('critical');
    expect(result.detail).toMatch(/has not ticked/);
  });

  it('does not complain about a stale tick when nothing is scheduled', async () => {
    const result = await schedulerCheck(source({ active: 0, lastTick: 60 * 60_000 })).run();

    expect(result.status).toBe('healthy');
  });

  it('warns about overdue schedules', async () => {
    expect((await schedulerCheck(source({ active: 3, overdue: 1 })).run()).status).toBe('warning');
  });

  it('warns about automatically disabled schedules', async () => {
    expect((await schedulerCheck(source({ active: 3, disabled: 2 })).run()).status).toBe('warning');
  });
});

describe('the dead-letter check', () => {
  it('is healthy with none', async () => {
    const result = await deadLetterCheck({
      unreplayedCount: async () => 0,
      oldestAgeMs: async () => null,
    }).run();

    expect(result.status).toBe('healthy');
  });

  it('warns about a few, because they are recoverable by replay', async () => {
    const result = await deadLetterCheck({
      unreplayedCount: async () => 3,
      oldestAgeMs: async () => 60_000,
    }).run();

    expect(result.status).toBe('warning');
    expect(result.remediation).toMatch(/replay/);
  });

  it('escalates when there are many or they are old', async () => {
    const many = await deadLetterCheck({
      unreplayedCount: async () => 500,
      oldestAgeMs: async () => 60_000,
    }).run();

    const old = await deadLetterCheck({
      unreplayedCount: async () => 2,
      oldestAgeMs: async () => 48 * 3_600_000,
    }).run();

    expect(many.status).toBe('critical');
    expect(old.status).toBe('critical');
  });
});

describe('the provider check', () => {
  it('is critical when a provider is unavailable, and names it', async () => {
    const result = await providerCheck({
      healthAll: async () => [
        { key: 'mail.smtp', health: { status: 'healthy', detail: 'fine' } },
        { key: 'storage.s3', health: { status: 'critical', detail: 'connection refused' } },
      ],
    }).run();

    expect(result.status).toBe('critical');
    expect(result.detail).toMatch(/storage\.s3.*connection refused/);
  });

  it('warns on a degraded provider', async () => {
    const result = await providerCheck({
      healthAll: async () => [{ key: 'mail.smtp', health: { status: 'warning', detail: 'slow' } }],
    }).run();

    expect(result.status).toBe('warning');
  });

  it('is healthy with no providers registered', async () => {
    expect((await providerCheck({ healthAll: async () => [] }).run()).status).toBe('healthy');
  });
});

describe('the sync check', () => {
  const source = (overrides: Record<string, number | null> = {}) => ({
    pausedConnections: async () => (overrides.paused as number) ?? 0,
    failedConnections: async () => (overrides.failed as number) ?? 0,
    unresolvedConflicts: async () => (overrides.conflicts as number) ?? 0,
    stalestSyncAgeMs: async () => (overrides.stalest as number | null) ?? null,
  });

  it('is critical when a connection is paused, because it is not syncing', async () => {
    const result = await syncCheck(source({ paused: 1 })).run();

    expect(result.status).toBe('critical');
    expect(result.remediation).toMatch(/resume it/);
  });

  it('warns when the stalest connection is a day behind', async () => {
    expect((await syncCheck(source({ stalest: 30 * 3_600_000 })).run()).status).toBe('warning');
  });

  it('warns about unresolved conflicts', async () => {
    const result = await syncCheck(source({ conflicts: 4 })).run();

    expect(result.status).toBe('warning');
    expect(result.detail).toMatch(/waiting for a decision/);
  });

  it('is healthy when everything is current', async () => {
    expect((await syncCheck(source()).run()).status).toBe('healthy');
  });
});
