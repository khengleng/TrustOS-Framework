import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { retryPolicySchema } from '@trustos/retry';
import { JOB_PRIORITY, isTerminal } from './entities';
import { JobQueue, MAX_SCHEDULE_AHEAD_MS } from './queue';
import { JobRegistry, type JobHandlerDefinition } from './registry';
import { InMemoryJobStore } from './testing';
import { JobWorker } from './worker';

const NO_WAIT = retryPolicySchema.parse({ maxAttempts: 5, initialDelayMs: 0, jitter: 'none' });

let clock = new Date('2026-07-01T10:00:00Z');
let counter = 0;

const echoHandler: JobHandlerDefinition = {
  type: 'test.echo',
  description: 'Returns its payload.',
  payload: z.object({ value: z.string() }).strict(),
  handle: async ({ payload }) => payload,
};

function setup(handlers: JobHandlerDefinition[] = [echoHandler]) {
  const store = new InMemoryJobStore(() => clock);
  const registry = new JobRegistry(handlers);
  const audit = { record: vi.fn() };

  const queue = new JobQueue({
    store,
    registry,
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  const worker = new JobWorker({
    store,
    registry,
    retry: NO_WAIT,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
    workerId: 'worker_test',
  });

  return { store, registry, queue, worker, audit };
}

beforeEach(() => {
  clock = new Date('2026-07-01T10:00:00Z');
  counter = 0;
});

describe('the registry', () => {
  it('refuses two handlers for one type', () => {
    const registry = new JobRegistry([echoHandler]);

    // Which one runs would otherwise depend on import order, and the symptom is a job doing the
    // wrong thing rather than failing.
    expect(() => registry.register(echoHandler)).toThrow(/already registered/);
  });

  it.each(['Test.Echo', 'test echo', '1test', ''])('rejects the type %j', (type) => {
    expect(() => new JobRegistry().register({ ...echoHandler, type })).toThrow();
  });

  it('lists the known types when asked for an unknown one', () => {
    const registry = new JobRegistry([echoHandler]);

    try {
      registry.get('test.missing');
      expect.unreachable();
    } catch (error) {
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details[0]?.message).toMatch(/Registered types: test\.echo/);
    }
  });
});

describe('enqueueing', () => {
  it('validates the payload synchronously, at the caller', async () => {
    const { queue } = setup();

    // The caller who built a bad payload gets the error in their own stack trace, rather than a
    // worker failing minutes later in a different process.
    await expect(
      queue.enqueue({ type: 'test.echo', payload: { value: 42 }, organizationId: 'org_1' }),
    ).rejects.toThrow(/not valid/);
  });

  it('refuses a job type with no handler', async () => {
    const { queue } = setup();

    await expect(
      queue.enqueue({ type: 'test.missing', payload: {}, organizationId: 'org_1' }),
    ).rejects.toThrow(/Unknown job type/);
  });

  it('takes the handler’s defaults for priority and attempts', async () => {
    const { queue } = setup([{ ...echoHandler, priority: JOB_PRIORITY.bulk, maxAttempts: 7 }]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    expect(job.priority).toBe(JOB_PRIORITY.bulk);
    expect(job.maxAttempts).toBe(7);
  });

  it('expresses a delay as a future runAt rather than a timer', async () => {
    const { queue, worker } = setup();
    const later = new Date(clock.getTime() + 60_000);

    await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
      runAt: later,
    });

    // No in-memory timer to lose on restart.
    expect(await worker.tick()).toBe(0);

    clock = new Date(later.getTime() + 1000);
    expect(await worker.tick()).toBe(1);
  });

  it('refuses a job scheduled absurdly far ahead, which is nearly always a unit mistake', async () => {
    const { queue } = setup();

    await expect(
      queue.enqueue({
        type: 'test.echo',
        payload: { value: 'x' },
        organizationId: 'org_1',
        runAt: new Date(clock.getTime() + MAX_SCHEDULE_AHEAD_MS + 1000),
      }),
    ).rejects.toThrow(/too far ahead/);
  });
});

describe('idempotency', () => {
  it('returns the existing job for a repeated key', async () => {
    const { queue } = setup();
    const input = {
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
      idempotencyKey: 'report:2026-07',
    };

    const first = await queue.enqueue(input);
    const second = await queue.enqueue(input);

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it('suppresses duplicates under concurrent enqueue', async () => {
    const { queue, store } = setup();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        queue.enqueue({
          type: 'test.echo',
          payload: { value: 'x' },
          organizationId: 'org_1',
          idempotencyKey: 'report:2026-07',
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(store.jobs.size).toBe(1);
  });

  it('frees the key once the job finishes, so the next run can reuse it', async () => {
    const { queue, worker } = setup();
    const input = {
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
      idempotencyKey: 'nightly:2026-07-01',
    };

    const first = await queue.enqueue(input);
    await worker.tick();

    // A nightly job keyed by its date could otherwise never re-run after a failure.
    const second = await queue.enqueue(input);
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it('scopes the key per organization, so one tenant cannot suppress another’s work', async () => {
    const { queue } = setup();
    const input = { type: 'test.echo', payload: { value: 'x' }, idempotencyKey: 'shared' };

    const a = await queue.enqueue({ ...input, organizationId: 'org_1' });
    const b = await queue.enqueue({ ...input, organizationId: 'org_2' });

    expect(b.created).toBe(true);
    expect(b.job.id).not.toBe(a.job.id);
  });
});

describe('running a job', () => {
  it('runs the handler and records the result', async () => {
    const { queue, worker } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'hello' },
      organizationId: 'org_1',
    });

    await worker.tick();

    const finished = await queue.get(job.id, 'org_1');
    expect(finished.status).toBe('succeeded');
    expect(finished.result).toEqual({ value: 'hello' });
    expect(finished.progress).toBe(100);
  });

  it('records a run per attempt, so the history explains what happened', async () => {
    let attempts = 0;
    const { queue, worker } = setup([
      {
        ...echoHandler,
        maxAttempts: 3,
        handle: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
          return { ok: true };
        },
      },
    ]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + 60_000);
      await worker.tick();
    }

    const runs = await queue.runs(job.id, 'org_1');
    expect(runs.map((run) => run.outcome)).toEqual(['failed', 'failed', 'succeeded']);
    expect((await queue.get(job.id, 'org_1')).status).toBe('succeeded');
  });

  it('fails permanently once attempts are exhausted', async () => {
    const { queue, worker } = setup([
      {
        ...echoHandler,
        maxAttempts: 2,
        handle: async () => {
          throw new Error('always broken');
        },
      },
    ]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + 60_000);
      await worker.tick();
    }

    const failed = await queue.get(job.id, 'org_1');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('always broken');
    expect(failed.attempts).toBe(2);
  });

  it('returns a retrying job to queued rather than a third state', async () => {
    const { queue, worker } = setup([
      {
        ...echoHandler,
        maxAttempts: 3,
        handle: async () => {
          throw new Error('transient');
        },
      },
    ]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    await worker.tick();

    // A job waiting for its next attempt is queued. A second state would mean every "what is
    // waiting" query has to know about two.
    expect((await queue.get(job.id, 'org_1')).status).toBe('queued');
  });

  it('reports progress a UI can show', async () => {
    const seen: number[] = [];
    const { queue, store, worker } = setup([
      {
        ...echoHandler,
        handle: async ({ reportProgress, jobId }) => {
          for (const percent of [25, 50, 75]) {
            await reportProgress(percent, `step ${percent}`);
            seen.push(store.jobs.get(jobId)!.progress);
          }
          return null;
        },
      },
    ]);

    await queue.enqueue({ type: 'test.echo', payload: { value: 'x' }, organizationId: 'org_1' });
    await worker.tick();

    expect(seen).toEqual([25, 50, 75]);
  });

  it('does not fail a job because a progress write failed', async () => {
    const { queue, store, worker } = setup([
      {
        ...echoHandler,
        handle: async ({ reportProgress }) => {
          await reportProgress(50);
          return { ok: true };
        },
      },
    ]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    const original = store.update.bind(store);
    let calls = 0;
    store.update = async (id, patch) => {
      calls += 1;
      if (calls === 2) throw new Error('write failed');
      return original(id, patch);
    };

    await worker.tick();

    expect((await queue.get(job.id, 'org_1')).status).toBe('succeeded');
  });

  it('respects priority ordering', async () => {
    const order: string[] = [];
    const { queue, worker } = setup([
      {
        ...echoHandler,
        handle: async ({ payload }) => {
          order.push((payload as { value: string }).value);
          return null;
        },
      },
    ]);

    await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'bulk' },
      organizationId: 'org_1',
      priority: JOB_PRIORITY.bulk,
    });
    await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'urgent' },
      organizationId: 'org_1',
      priority: JOB_PRIORITY.interactive,
    });

    await worker.tick();

    // Lower number first — the `nice` convention, and the opposite of what people usually guess,
    // which is why the constants are named.
    expect(order).toEqual(['urgent', 'bulk']);
  });

  it('runs only the types a dedicated worker asked for', async () => {
    const { store, registry, queue } = setup([
      echoHandler,
      { ...echoHandler, type: 'test.other', handle: async () => null },
    ]);

    await queue.enqueue({ type: 'test.echo', payload: { value: 'x' }, organizationId: 'org_1' });
    await queue.enqueue({ type: 'test.other', payload: { value: 'x' }, organizationId: 'org_1' });

    const dedicated = new JobWorker({
      store,
      registry,
      types: ['test.other'],
      now: () => clock,
      workerId: 'worker_other',
    });

    expect(await dedicated.tick()).toBe(1);
  });
});

describe('timeouts', () => {
  it('aborts a handler that exceeds its timeout', async () => {
    let aborted = false;

    const { queue, store, registry } = setup([
      {
        ...echoHandler,
        timeoutMs: 20,
        maxAttempts: 1,
        handle: async ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      },
    ]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    // A worker on the real clock, because the timeout is measured with `setTimeout` rather than
    // with the injected clock — a frozen clock would never let it fire.
    await new JobWorker({ store, registry, retry: NO_WAIT, workerId: 'worker_timeout' }).tick();

    // The signal fires, not merely a lost race — a race alone would leave the handler running,
    // still holding its database connection, invisible.
    expect(aborted).toBe(true);
    const finished = await queue.get(job.id, 'org_1');
    expect(finished.status).toBe('failed');
    expect(finished.error).toMatch(/exceeded its 20ms timeout/);
  });

  it('lets a handler opt out of the timeout deliberately', async () => {
    const { queue, worker } = setup([
      {
        ...echoHandler,
        timeoutMs: null,
        handle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { ok: true };
        },
      },
    ]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });
    await worker.tick();

    expect((await queue.get(job.id, 'org_1')).status).toBe('succeeded');
  });
});

describe('leases', () => {
  it('does not let two workers claim the same job', async () => {
    const { store, registry, queue } = setup();
    await queue.enqueue({ type: 'test.echo', payload: { value: 'x' }, organizationId: 'org_1' });

    const a = new JobWorker({ store, registry, now: () => clock, workerId: 'a' });
    const b = new JobWorker({ store, registry, now: () => clock, workerId: 'b' });

    const [first, second] = await Promise.all([a.tick(), b.tick()]);

    expect(first + second).toBe(1);
  });

  it('reclaims a job whose worker died mid-run', async () => {
    const { store, registry, queue } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    // A worker claims it and then vanishes without completing.
    await store.claim({ workerId: 'dead_worker', now: clock, limit: 1, leaseMs: 60_000 });
    expect(store.jobs.get(job.id)?.status).toBe('running');

    clock = new Date(clock.getTime() + 61_000);

    const survivor = new JobWorker({ store, registry, now: () => clock, workerId: 'alive' });
    expect(await survivor.tick()).toBe(1);
    expect((await queue.get(job.id, 'org_1')).status).toBe('succeeded');
  });

  it('refuses a renewal from a worker that no longer owns the job', async () => {
    const { store, queue } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    await store.claim({ workerId: 'owner', now: clock, limit: 1, leaseMs: 60_000 });

    // How the superseded owner learns it has been superseded.
    expect(await store.renewLease(job.id, 'someone_else', new Date())).toBe(false);
    expect(await store.renewLease(job.id, 'owner', new Date())).toBe(true);
  });
});

describe('cancellation', () => {
  it('cancels a queued job', async () => {
    const { queue, worker } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    await queue.cancel(job.id, 'org_1', { actorId: 'usr_1', reason: 'no longer needed' });

    expect((await queue.get(job.id, 'org_1')).status).toBe('cancelled');
    expect(await worker.tick()).toBe(0);
  });

  it('refuses to cancel a job that has already finished', async () => {
    const { queue, worker } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });
    await worker.tick();

    await expect(queue.cancel(job.id, 'org_1', { actorId: 'usr_1' })).rejects.toThrow(
      /already succeeded/,
    );
  });

  it('records who cancelled it and why', async () => {
    const { queue, audit } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    await queue.cancel(job.id, 'org_1', { actorId: 'usr_1', reason: 'superseded' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'job.cancelled', actorId: 'usr_1' }),
    );
  });

  it('does not return another organization’s job', async () => {
    const { queue } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });

    await expect(queue.get(job.id, 'org_2')).rejects.toThrow(/No job/);
  });
});

describe('retrying a failed job', () => {
  it('tops up the attempt budget, so it does not fail again immediately', async () => {
    const { queue, store, worker } = setup([
      { ...echoHandler, maxAttempts: 1, handle: async () => ({ ok: true }) },
    ]);

    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
      maxAttempts: 1,
    });

    // Forced to a failed state, as if the handler had thrown.
    await store.update(job.id, {
      status: 'failed',
      attempts: 1,
      completedAt: clock,
      error: 'boom',
    });

    const retried = await queue.retry(job.id, 'org_1', { actorId: 'usr_1' });
    expect(retried.status).toBe('queued');
    expect(retried.maxAttempts).toBe(2);

    await worker.tick();
    expect((await queue.get(job.id, 'org_1')).status).toBe('succeeded');
  });

  it('refuses to retry a running job', async () => {
    const { queue, store } = setup();
    const { job } = await queue.enqueue({
      type: 'test.echo',
      payload: { value: 'x' },
      organizationId: 'org_1',
    });
    await store.claim({ workerId: 'w', now: clock, limit: 1, leaseMs: 60_000 });

    await expect(queue.retry(job.id, 'org_1', { actorId: 'usr_1' })).rejects.toThrow(
      /Only a failed or cancelled job/,
    );
  });
});

describe('queue statistics', () => {
  it('counts by status, per organization', async () => {
    const { queue, worker } = setup();

    await queue.enqueue({ type: 'test.echo', payload: { value: 'a' }, organizationId: 'org_1' });
    await queue.enqueue({ type: 'test.echo', payload: { value: 'b' }, organizationId: 'org_1' });
    await queue.enqueue({ type: 'test.echo', payload: { value: 'c' }, organizationId: 'org_2' });

    await worker.tick();

    expect(await queue.stats('org_1')).toMatchObject({ succeeded: 2, queued: 0 });
    expect(await queue.stats('org_2')).toMatchObject({ succeeded: 1 });
  });
});

describe('terminal states', () => {
  it.each([
    ['succeeded', true],
    ['failed', true],
    ['cancelled', true],
    ['queued', false],
    ['running', false],
  ] as const)('isTerminal(%s) is %s', (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});
