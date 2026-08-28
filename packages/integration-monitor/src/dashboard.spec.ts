import { describe, expect, it, vi } from 'vitest';
import { IntegrationHealthService } from '@trustos/integration-health';
import { IntegrationMonitor, type MonitorSource } from './dashboard';

function source(overrides: Partial<MonitorSource> = {}): MonitorSource {
  return {
    events: async () => ({ publishedLastHour: 1200, deadLettered: 0, subscribers: 7 }),
    webhooks: async () => ({
      endpoints: 12,
      activeEndpoints: 11,
      disabledEndpoints: 1,
      deliveredLastHour: 980,
      failedLastHour: 4,
      pending: 6,
      successRate: 0.996,
      p95LatencyMs: 210,
    }),
    jobs: async () => ({
      queued: 3,
      running: 2,
      succeededLastHour: 410,
      failedLastHour: 1,
      oldestQueuedMinutes: 1,
    }),
    schedules: async () => ({
      active: 9,
      paused: 0,
      disabled: 0,
      firedLastHour: 14,
      missedLastHour: 0,
    }),
    sync: async () => ({
      connections: 2,
      running: 0,
      paused: 0,
      unresolvedConflicts: 0,
      recordsLastHour: 320,
    }),
    providers: async () => [
      { key: 'mail.smtp', status: 'healthy' as const, detail: 'reachable', circuit: 'closed' },
    ],
    ...overrides,
  };
}

function monitor(
  overrides: Partial<MonitorSource> = {},
  checkStatus: 'healthy' | 'critical' = 'healthy',
) {
  const health = new IntegrationHealthService().register({
    key: 'test.check',
    description: 'A check.',
    run: async () => ({
      status: checkStatus,
      detail: `the check is ${checkStatus}`,
      remediation: checkStatus === 'critical' ? 'Fix the thing.' : undefined,
    }),
  });

  return new IntegrationMonitor({
    source: source(overrides),
    health,
    now: () => new Date('2026-07-01T10:00:00Z'),
  });
}

describe('the snapshot', () => {
  it('gathers every section', async () => {
    const snapshot = await monitor().snapshot('org_1');

    expect(snapshot.organizationId).toBe('org_1');
    expect(snapshot.events.publishedLastHour).toBe(1200);
    expect(snapshot.webhooks.endpoints).toBe(12);
    expect(snapshot.jobs.queued).toBe(3);
    expect(snapshot.schedules.active).toBe(9);
    expect(snapshot.sync.connections).toBe(2);
    expect(snapshot.providers).toHaveLength(1);
  });

  it('survives one section failing', async () => {
    // A dashboard that failed entirely because the sync counters were slow would be useless
    // during the incident it exists for.
    const snapshot = await monitor({
      sync: async () => {
        throw new Error('the query timed out');
      },
    }).snapshot('org_1');

    expect(snapshot.sync.connections).toBe(0);
    expect(snapshot.jobs.queued).toBe(3);
  });

  it('still reports the health status when a counter section fails', async () => {
    // The health report is computed separately, and it is what says something is wrong.
    const snapshot = await monitor(
      {
        jobs: async () => {
          throw new Error('down');
        },
      },
      'critical',
    ).snapshot('org_1');

    expect(snapshot.health.status).toBe('critical');
  });

  it('passes the organization to every source', async () => {
    const events = vi.fn(async () => ({ publishedLastHour: 0, deadLettered: 0, subscribers: 0 }));

    await monitor({ events }).snapshot('org_7');

    expect(events).toHaveBeenCalledWith('org_7');
  });
});

describe('the summary strip', () => {
  it('reports five headline numbers', async () => {
    // Anything more belongs on the full dashboard; a strip with fifteen numbers is one nobody
    // reads.
    const target = monitor();
    const summary = target.summarize(await target.snapshot('org_1'));

    expect(summary).toHaveLength(5);
    expect(summary.map((entry) => entry.label)).toEqual([
      'Integration health',
      'Webhook success',
      'Jobs queued',
      'Dead letters',
      'Sync conflicts',
    ]);
  });

  it('judges the queue on wait time rather than depth', async () => {
    // A deep queue that drains fast is a busy system.
    const busy = monitor({
      jobs: async () => ({
        queued: 5000,
        running: 20,
        succeededLastHour: 90_000,
        failedLastHour: 0,
        oldestQueuedMinutes: 1,
      }),
    });

    const stuck = monitor({
      jobs: async () => ({
        queued: 5,
        running: 0,
        succeededLastHour: 0,
        failedLastHour: 0,
        oldestQueuedMinutes: 45,
      }),
    });

    expect(
      busy.summarize(await busy.snapshot(null)).find((e) => e.label === 'Jobs queued')?.status,
    ).toBe('healthy');
    expect(
      stuck.summarize(await stuck.snapshot(null)).find((e) => e.label === 'Jobs queued')?.status,
    ).toBe('critical');
  });

  it('grades webhook success by rate', async () => {
    const degraded = monitor({
      webhooks: async () => ({
        endpoints: 5,
        activeEndpoints: 5,
        disabledEndpoints: 0,
        deliveredLastHour: 50,
        failedLastHour: 50,
        pending: 0,
        successRate: 0.5,
        p95LatencyMs: null,
      }),
    });

    const entry = degraded
      .summarize(await degraded.snapshot(null))
      .find((e) => e.label === 'Webhook success');

    expect(entry?.status).toBe('critical');
    expect(entry?.value).toBe('50%');
  });
});

describe('problems', () => {
  it('orders by severity, worst first', async () => {
    const target = monitor(
      {
        providers: async () => [
          { key: 'a.warn', status: 'warning', detail: 'slow', circuit: 'closed' },
          { key: 'b.fine', status: 'healthy', detail: 'fine', circuit: 'closed' },
        ],
      },
      'critical',
    );

    const problems = target.problems(await target.snapshot('org_1'));

    // An operator opening a dashboard during an incident wants the first line to be the thing to
    // fix, not an alphabetical list.
    expect(problems[0]?.status).toBe('critical');
    expect(problems.map((problem) => problem.area)).toEqual(['test.check', 'provider.a.warn']);
  });

  it('omits healthy providers', async () => {
    const target = monitor();

    expect(target.problems(await target.snapshot('org_1'))).toEqual([]);
  });

  it('says when a circuit is open, because that changes what the failure means', async () => {
    const target = monitor({
      providers: async () => [
        { key: 'storage.s3', status: 'critical', detail: 'unreachable.', circuit: 'open' },
      ],
    });

    const problems = target.problems(await target.snapshot('org_1'));

    expect(problems[0]?.detail).toMatch(/circuit is open, so calls are failing fast/);
  });

  it('carries the remediation through from the check', async () => {
    const target = monitor({}, 'critical');

    expect(target.problems(await target.snapshot('org_1'))[0]?.remediation).toBe('Fix the thing.');
  });
});

describe('the text rendering', () => {
  it('leads with the overall status', async () => {
    const target = monitor();
    const text = target.render(await target.snapshot('org_1'));

    expect(text.split('\n')[0]).toBe('Integration health: HEALTHY');
  });

  it('lists every check with a readable marker', async () => {
    const target = monitor();
    const text = target.render(await target.snapshot('org_1'));

    expect(text).toMatch(/\[ok {2}\] test\.check\s+the check is healthy/);
  });

  it('includes the counters', async () => {
    const target = monitor();
    const text = target.render(await target.snapshot('org_1'));

    expect(text).toContain('webhooks      11/12 active, 100% success, 6 pending');
    expect(text).toContain('jobs          3 queued, 2 running, 1 failed/h');
  });

  it('adds a "what to do" section only when something is wrong', async () => {
    const healthy = monitor();
    const broken = monitor({}, 'critical');

    expect(healthy.render(await healthy.snapshot('org_1'))).not.toContain('What to do');

    const text = broken.render(await broken.snapshot('org_1'));
    expect(text).toContain('What to do');
    expect(text).toContain('→ Fix the thing.');
  });

  it('marks an open circuit in the provider list', async () => {
    const target = monitor({
      providers: async () => [
        { key: 'storage.s3', status: 'critical', detail: 'unreachable', circuit: 'open' },
      ],
    });

    expect(target.render(await target.snapshot('org_1'))).toContain('(circuit open)');
  });

  it('produces plain text with no escape codes, so it pastes into a ticket', async () => {
    const target = monitor({}, 'critical');
    const text = target.render(await target.snapshot('org_1'));

    // A literal ESC byte in a source file is invisible in most diffs, so the escape is spelled
    // out rather than embedded.
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\u001b\[/);
  });
});
