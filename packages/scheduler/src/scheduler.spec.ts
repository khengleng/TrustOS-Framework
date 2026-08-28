import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { JobQueue, JobRegistry, InMemoryJobStore } from '@trustos/job-runtime';
import { MISFIRE_THRESHOLD_MS, SCHEDULE_FAILURE_THRESHOLD } from './entities';
import { Scheduler } from './scheduler';
import { InMemoryScheduleStore } from './testing';

/** The detail of a validation error — `toThrow` only sees the one-line `ApiError` summary. */
async function detailsOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const details = (error as { details?: Array<{ message: string }> }).details ?? [];
    return [(error as Error).message, ...details.map((entry) => entry.message)].join(' | ');
  }
  throw new Error('Expected the call to reject, and it did not.');
}

let clock = new Date('2026-07-01T10:00:00Z');
let counter = 0;

function setup() {
  const jobStore = new InMemoryJobStore(() => clock);
  const registry = new JobRegistry([
    {
      type: 'test.report',
      description: 'Builds a report.',
      payload: z.object({}).passthrough(),
      handle: async () => null,
    },
  ]);

  const queue = new JobQueue({
    store: jobStore,
    registry,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  const store = new InMemoryScheduleStore(() => clock);
  const audit = { record: vi.fn() };

  const scheduler = new Scheduler({
    store,
    queue,
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { scheduler, store, jobStore, queue, audit };
}

const nightly = {
  key: 'nightly-report',
  organizationId: 'org_1' as string | null,
  kind: 'cron' as const,
  expression: '0 3 * * *',
  timezone: 'Asia/Phnom_Penh',
  jobType: 'test.report',
  jobPayload: { scope: 'all' },
};

beforeEach(() => {
  clock = new Date('2026-07-01T10:00:00Z');
  counter = 0;
});

describe('defining a schedule', () => {
  it('computes the next run at definition time', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define(nightly);

    // 03:00 in Phnom Penh is 20:00 UTC the previous day.
    expect(schedule.nextRunAt?.toISOString()).toBe('2026-07-01T20:00:00.000Z');
  });

  it('rejects a bad expression at definition time, not at the first tick', async () => {
    const { scheduler } = setup();

    // The alternative is a failure in a background process, hours later, that nobody is watching.
    await expect(scheduler.define({ ...nightly, expression: '0 99 * * *' })).rejects.toThrow();
  });

  it('rejects an unknown timezone', async () => {
    const { scheduler } = setup();

    await expect(scheduler.define({ ...nightly, timezone: 'Mars/Olympus' })).rejects.toThrow(
      /Unknown timezone/,
    );
  });

  it('upserts by key, so redeploying does not accumulate duplicates', async () => {
    const { scheduler, store } = setup();

    const first = await scheduler.define(nightly);
    const second = await scheduler.define({ ...nightly, expression: '0 4 * * *' });

    expect(second.id).toBe(first.id);
    expect(store.schedules.size).toBe(1);
    expect(second.expression).toBe('0 4 * * *');
  });

  it('keeps a paused schedule paused across a redefinition', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define(nightly);
    await scheduler.pause(schedule.id, 'org_1', 'usr_1');

    const redefined = await scheduler.define(nightly);

    // Redeploying must not silently restart a schedule somebody deliberately paused.
    expect(redefined.status).toBe('paused');
  });

  it('refuses an interval below a second, which is a poll loop rather than a schedule', async () => {
    const { scheduler } = setup();

    expect(
      await detailsOf(() =>
        scheduler.define({ ...nightly, kind: 'interval', expression: undefined, intervalMs: 100 }),
      ),
    ).toMatch(/at least 1000ms/);
  });

  it('refuses a cron schedule with no expression', async () => {
    const { scheduler } = setup();

    expect(await detailsOf(() => scheduler.define({ ...nightly, expression: undefined }))).toMatch(
      /needs an expression/,
    );
  });

  it('refuses a one-time schedule with no time', async () => {
    const { scheduler } = setup();

    expect(
      await detailsOf(() => scheduler.define({ ...nightly, kind: 'once', expression: undefined })),
    ).toMatch(/needs a time to run at/);
  });
});

describe('firing', () => {
  it('enqueues a job when the schedule is due', async () => {
    const { scheduler, jobStore } = setup();
    await scheduler.define(nightly);

    clock = new Date('2026-07-01T20:00:00Z');
    expect(await scheduler.tick()).toBe(1);

    const [job] = [...jobStore.jobs.values()];
    expect(job?.type).toBe('test.report');
    expect(job?.payload).toEqual({ scope: 'all' });
    expect(job?.metadata.scheduleKey).toBe('nightly-report');
  });

  it('does not fire before it is due', async () => {
    const { scheduler } = setup();
    await scheduler.define(nightly);

    clock = new Date('2026-07-01T19:59:00Z');
    expect(await scheduler.tick()).toBe(0);
  });

  it('advances to the next occurrence after firing', async () => {
    const { scheduler, store } = setup();
    const schedule = await scheduler.define(nightly);

    clock = new Date('2026-07-01T20:00:00Z');
    await scheduler.tick();

    expect(store.schedules.get(schedule.id)?.nextRunAt?.toISOString()).toBe(
      '2026-07-02T20:00:00.000Z',
    );
  });

  it('fires once across two scheduler instances', async () => {
    // The normal deployment is one scheduler per replica, and both tick at the same second. For a
    // nightly billing run, firing per replica means billing everybody twice.
    const { scheduler, store, queue, jobStore } = setup();
    await scheduler.define(nightly);

    const second = new Scheduler({
      store,
      queue,
      now: () => clock,
      newId: (prefix) => `${prefix}_b${++counter}`,
    });

    clock = new Date('2026-07-01T20:00:00Z');
    const [a, b] = await Promise.all([scheduler.tick(), second.tick()]);

    expect(a + b).toBe(1);
    expect(jobStore.jobs.size).toBe(1);
  });

  it('keys the job by its scheduled time, so a double fire collapses in the queue', async () => {
    const { scheduler, jobStore } = setup();
    await scheduler.define(nightly);

    clock = new Date('2026-07-01T20:00:00Z');
    await scheduler.tick();

    const [job] = [...jobStore.jobs.values()];
    // The second line of defence. The claim should already have prevented a double fire; the
    // consequence of both mechanisms failing is duplicated business work.
    expect(job?.idempotencyKey).toMatch(/^schedule:sched_\d+:2026-07-01T20:00:00\.000Z$/);
  });

  it('records a run per fire, with how late it was', async () => {
    const { scheduler, store } = setup();
    const schedule = await scheduler.define(nightly);

    clock = new Date('2026-07-01T20:00:30Z');
    await scheduler.tick();

    const [run] = await scheduler.runs(schedule.id, 'org_1');
    expect(run?.outcome).toBe('enqueued');
    expect(run?.latencyMs).toBe(30_000);
    void store;
  });

  it('does not fire a paused schedule', async () => {
    const { scheduler, jobStore } = setup();
    const schedule = await scheduler.define(nightly);
    await scheduler.pause(schedule.id, 'org_1', 'usr_1');

    clock = new Date('2026-07-01T20:00:00Z');
    await scheduler.tick();

    expect(jobStore.jobs.size).toBe(0);
  });

  it('disables a one-time schedule once it has run', async () => {
    const { scheduler, store } = setup();
    const schedule = await scheduler.define({
      ...nightly,
      kind: 'once',
      expression: undefined,
      runAt: new Date('2026-07-01T11:00:00Z'),
    });

    clock = new Date('2026-07-01T11:00:00Z');
    await scheduler.tick();

    const after = store.schedules.get(schedule.id);
    // Sitting active with a null next run reads as "broken" in every listing.
    expect(after?.status).toBe('disabled');
    expect(after?.nextRunAt).toBeNull();
  });

  it('advances an interval schedule from the run rather than the definition', async () => {
    const { scheduler, store } = setup();
    const schedule = await scheduler.define({
      ...nightly,
      kind: 'interval',
      expression: undefined,
      intervalMs: 60_000,
    });

    clock = new Date('2026-07-01T10:01:00Z');
    await scheduler.tick();

    expect(store.schedules.get(schedule.id)?.nextRunAt?.toISOString()).toBe(
      '2026-07-01T10:02:00.000Z',
    );
  });
});

describe('misfires', () => {
  it('runs once when the process was down, rather than working through a backlog', async () => {
    const { scheduler, jobStore } = setup();
    await scheduler.define(nightly);

    // Six hours late. `run_once` is the default for exactly this: six hours of downtime should
    // not produce six nightly reports.
    clock = new Date('2026-07-02T02:00:00Z');
    await scheduler.tick();

    expect(jobStore.jobs.size).toBe(1);
  });

  it('skips a very late fire when the policy says so', async () => {
    const { scheduler, jobStore, store } = setup();
    const schedule = await scheduler.define({ ...nightly, misfirePolicy: 'skip' });

    clock = new Date(new Date('2026-07-01T20:00:00Z').getTime() + MISFIRE_THRESHOLD_MS + 60_000);
    await scheduler.tick();

    expect(jobStore.jobs.size).toBe(0);
    const [run] = await scheduler.runs(schedule.id, 'org_1');
    expect(run?.outcome).toBe('skipped_misfire');
    // Still advanced, so it does not retry the missed fire forever.
    expect(store.schedules.get(schedule.id)?.nextRunAt).not.toBeNull();
  });

  it('runs a slightly-late fire regardless of policy', async () => {
    const { scheduler, jobStore } = setup();
    await scheduler.define({ ...nightly, misfirePolicy: 'skip' });

    // Inside the threshold this is the scheduler being a little behind — a busy tick, a slow
    // database — and running the job is right.
    clock = new Date(new Date('2026-07-01T20:00:00Z').getTime() + 30_000);
    await scheduler.tick();

    expect(jobStore.jobs.size).toBe(1);
  });
});

describe('failure handling', () => {
  it('records the error and keeps going when a job type is unregistered', async () => {
    const { scheduler, store } = setup();
    const schedule = await scheduler.define({ ...nightly, jobType: 'test.report' });

    // The job type disappears, as it would after a refactor that renamed a handler.
    await store.update(schedule.id, {});
    store.schedules.set(schedule.id, {
      ...store.schedules.get(schedule.id)!,
      jobType: 'test.gone',
    });

    clock = new Date('2026-07-01T20:00:00Z');
    await expect(scheduler.tick()).resolves.toBe(1);

    const updated = store.schedules.get(schedule.id);
    expect(updated?.consecutiveFailures).toBe(1);
    expect(updated?.lastError).toMatch(/Unknown job type/);
  });

  it('disables a schedule that repeatedly cannot enqueue', async () => {
    const { scheduler, store } = setup();
    const schedule = await scheduler.define(nightly);
    store.schedules.set(schedule.id, {
      ...store.schedules.get(schedule.id)!,
      jobType: 'test.gone',
    });

    for (let i = 0; i < SCHEDULE_FAILURE_THRESHOLD; i += 1) {
      clock = new Date(clock.getTime() + 24 * 3_600_000);
      store.schedules.set(schedule.id, {
        ...store.schedules.get(schedule.id)!,
        nextRunAt: clock,
      });
      await scheduler.tick();
    }

    // Firing every ten seconds against a handler that no longer exists just fills the log with
    // the same error until somebody notices.
    expect(store.schedules.get(schedule.id)?.status).toBe('disabled');
  });

  it('does not let one bad schedule stop the others', async () => {
    const { scheduler, store, jobStore } = setup();
    const broken = await scheduler.define({ ...nightly, key: 'broken' });
    await scheduler.define({ ...nightly, key: 'working' });

    store.schedules.set(broken.id, { ...store.schedules.get(broken.id)!, jobType: 'test.gone' });

    clock = new Date('2026-07-01T20:00:00Z');
    await scheduler.tick();

    expect(jobStore.jobs.size).toBe(1);
  });
});

describe('pause and resume', () => {
  it('keeps the next run while paused, so resuming does not lose it', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define(nightly);

    const paused = await scheduler.pause(schedule.id, 'org_1', 'usr_1');

    expect(paused.status).toBe('paused');
    expect(paused.nextRunAt?.toISOString()).toBe('2026-07-01T20:00:00.000Z');
  });

  it('recomputes the next run on resume, rather than firing for a time long past', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define(nightly);
    await scheduler.pause(schedule.id, 'org_1', 'usr_1');

    clock = new Date('2026-08-01T10:00:00Z');
    const resumed = await scheduler.resume(schedule.id, 'org_1', 'usr_1');

    expect(resumed.status).toBe('active');
    expect(resumed.nextRunAt?.toISOString()).toBe('2026-08-01T20:00:00.000Z');
  });

  it('refuses to pause a disabled schedule', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define(nightly);
    await scheduler.disable(schedule.id, 'org_1', 'usr_1');

    await expect(scheduler.pause(schedule.id, 'org_1', 'usr_1')).rejects.toThrow(/disabled/);
  });

  it('audits every state change', async () => {
    const { scheduler, audit } = setup();
    const schedule = await scheduler.define(nightly);

    await scheduler.pause(schedule.id, 'org_1', 'usr_1');
    await scheduler.resume(schedule.id, 'org_1', 'usr_1');

    const actions = audit.record.mock.calls.map(([entry]) => (entry as { action: string }).action);
    expect(actions).toEqual(['schedule.created', 'schedule.paused', 'schedule.resumed']);
  });
});

describe('run now', () => {
  it('enqueues immediately without cancelling the scheduled run', async () => {
    const { scheduler, store, jobStore } = setup();
    const schedule = await scheduler.define(nightly);
    const before = store.schedules.get(schedule.id)?.nextRunAt;

    clock = new Date('2026-07-01T15:00:00Z');
    await scheduler.runNow(schedule.id, 'org_1', 'usr_1');

    expect(jobStore.jobs.size).toBe(1);
    // An operator testing a nightly job at 3pm should not thereby cancel tonight's run.
    expect(store.schedules.get(schedule.id)?.nextRunAt).toEqual(before);
  });

  it('is not collapsed into the scheduled job', async () => {
    const { scheduler, jobStore } = setup();
    const schedule = await scheduler.define(nightly);

    clock = new Date('2026-07-01T20:00:00Z');
    await scheduler.tick();
    await scheduler.runNow(schedule.id, 'org_1', 'usr_1');

    expect(jobStore.jobs.size).toBe(2);
  });
});

describe('tenant isolation', () => {
  it('does not return another organization’s schedule', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define(nightly);

    await expect(scheduler.get(schedule.id, 'org_2')).rejects.toThrow(/No schedule/);
  });

  it('keys are scoped per organization', async () => {
    const { scheduler, store } = setup();

    const a = await scheduler.define(nightly);
    const b = await scheduler.define({ ...nightly, organizationId: 'org_2' });

    expect(b.id).not.toBe(a.id);
    expect(store.schedules.size).toBe(2);
  });
});

describe('describe', () => {
  it('renders a cron schedule in words', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define(nightly);

    expect(scheduler.describe(schedule)).toBe('at 03:00, every day (Asia/Phnom_Penh)');
  });

  it('renders an interval schedule', async () => {
    const { scheduler } = setup();
    const schedule = await scheduler.define({
      ...nightly,
      kind: 'interval',
      expression: undefined,
      intervalMs: 300_000,
    });

    expect(scheduler.describe(schedule)).toBe('every 5 minutes');
  });
});
