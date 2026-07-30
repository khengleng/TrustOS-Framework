# Scheduler and jobs

A job is work that happens outside a request. A schedule is a job that happens later, or
repeatedly. The queue is the database, and there is no broker to install.

- [Jobs](#jobs)
- [The lease](#the-lease)
- [Schedules](#schedules)
- [Timezones and daylight saving](#timezones-and-daylight-saving)
- [Misfires](#misfires)
- [Running the workers](#running-the-workers)

---

## Jobs

Register a handler at start-up, with a payload schema:

```ts
registry.register({
  type: 'report.monthly_summary',
  description: 'Builds the monthly summary for one organization.',
  payload: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).strict(),
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  handle: async ({ payload, organizationId, reportProgress, signal }) => {
    const rows = await load(organizationId, payload.month);

    for (const [index, row] of rows.entries()) {
      if (signal.aborted) return; // honour cancellation
      await process(row);
      if (index % 100 === 0) await reportProgress((index / rows.length) * 100);
    }

    return { rows: rows.length };
  },
});
```

Enqueue:

```ts
const { job, created } = await queue.enqueue({
  type: 'report.monthly_summary',
  payload: { month: '2026-09' },
  organizationId: org.id,
  idempotencyKey: `monthly-summary:${org.id}:2026-09`,
});
```

**The payload is validated synchronously, at the caller.** Whoever built a bad payload gets the
error in their own stack trace rather than a worker failing minutes later in a different process,
attached to nothing they can see.

**`idempotencyKey` makes a double-click produce one job.** It is a partial unique index over
non-terminal jobs, so the key is released once the job finishes — a nightly job keyed by its date
can re-run after a failure.

A delay is a future `runAt`, not a timer:

```ts
await queue.enqueue({ ..., runAt: new Date(Date.now() + 60_000) });
```

There is no in-memory timer to lose on restart.

### Priority

Lower runs first — the `nice` convention, and the opposite of what people usually guess, which is
why the constants exist:

```ts
JOB_PRIORITY.interactive; //   0  a user is waiting
JOB_PRIORITY.normal; //  50
JOB_PRIORITY.bulk; // 100  nobody is watching
```

## The lease

This is the part worth understanding before changing anything.

A worker claims a job with an expiry and renews the lease while the handler runs. If the process
dies, the lease expires and another worker picks the job up. If the handler is merely slow,
renewal keeps the claim alive.

The consequence: **a renewal that fails means this worker is no longer the owner.** It aborts the
handler and discards its outcome. Two workers both writing a result for one job would produce a
record saying it succeeded once and failed once, with no way to tell which run it describes.

A `JobStore` implementation must make `claim` atomic — `FOR UPDATE SKIP LOCKED`, or an
`UPDATE ... RETURNING`. A store that reads then writes runs every job twice the moment a second
worker starts.

## Schedules

```ts
await scheduler.define({
  key: 'nightly-reconciliation',
  organizationId: org.id,
  kind: 'cron',
  expression: '0 3 * * *',
  timezone: 'Asia/Phnom_Penh',
  jobType: 'reconciliation.nightly',
  jobPayload: { scope: 'all' },
  misfirePolicy: 'run_once',
});
```

Keyed and upserted, because schedules are usually declared in code and reconciled at start-up — a
create would either fail on the second boot or accumulate one per deployment. A schedule that
somebody paused stays paused across a redefinition.

Three kinds: `cron` (an expression), `interval` (every N milliseconds), `once` (a fixed time, then
it disables itself).

Cron is five fields — minute, hour, day-of-month, month, day-of-week — plus `@daily`, `@hourly`
and friends. Six-field expressions with a seconds column are refused rather than guessed at,
because the dialects disagree about which end it goes on.

One inherited surprise, matched deliberately: when **both** day-of-month and day-of-week are
restricted, cron matches if **either** does. `0 0 1 * mon` runs on the first of the month _and_
every Monday.

## Timezones and daylight saving

`timezone` is an IANA name and it is not decoration. "Run at 2am" means nothing without one, and
defaulting to UTC silently means "run at 9am" for a team in Phnom Penh.

Both daylight-saving edge cases are handled explicitly, because both are silent when wrong and
both happen twice a year:

**The hour that happens twice.** When clocks fall back, 01:30 occurs twice. The job runs **once**,
on the first occurrence. Running the nightly reconciliation twice is much worse than running it at
the earlier of two 01:30s.

**The hour that does not exist.** When clocks spring forward, 02:30 may not happen at all. A naive
implementation finds nothing at 02:30, moves to tomorrow, and silently skips a day — discovered
when the numbers do not add up. Instead the job fires at the first real instant after the gap:
late, rather than not at all.

Verified against `America/New_York` for 2026 in `cron.spec.ts`, in both directions.

## Misfires

A fire more than five minutes late means the process was probably down.

| Policy               | Behaviour                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `run_once` (default) | Run it now, once, and move on. Six hours of downtime produces one nightly report, not six. |
| `skip`               | Wait for the next scheduled time.                                                          |
| `run_all`            | Work through the backlog. Available, almost always wrong.                                  |

Below five minutes it is the scheduler being slightly behind — a busy tick, a slow database — and
the job runs regardless of policy.

A schedule that fails to enqueue ten times running is **disabled**. The usual cause is a job type
that no longer exists after a refactor, and firing every ten seconds against it just fills the log
with the same error.

## Running the workers

The API process does not process queues:

```ts
const jobs = new JobWorker({ store, registry, concurrency: 5 });
const scheduler = new Scheduler({ store: schedules, queue });

jobs.start();
scheduler.start(10_000);

process.on('SIGTERM', async () => {
  await Promise.all([jobs.stop(), scheduler.stop()]);
});
```

`stop()` waits for in-flight work. Exiting immediately leaves rows claimed by a process that no
longer exists, which needs a reaper to recover — and reapers are how "at least once" quietly
becomes "sometimes never".

Two scheduler instances is the normal deployment, one per replica. Both tick at the same second,
and `claimDue` is what stops both firing: it advances `nextRunAt` in the same statement as the
read. The job's idempotency key is a second line of defence, because the consequence of both
mechanisms failing is duplicated business work.

---

**See also:** [automation.md](automation.md) ·
[integration-architecture.md](integration-architecture.md)
