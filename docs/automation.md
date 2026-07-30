# Automation

Putting the integration layer together: what runs where, how to wire it, and how to tell whether
it is working.

- [The processes](#the-processes)
- [Wiring an application](#wiring-an-application)
- [A worked example](#a-worked-example)
- [Import and export](#import-and-export)
- [Generating API clients](#generating-api-clients)
- [Health and monitoring](#health-and-monitoring)
- [Operational runbook](#operational-runbook)

---

## The processes

An application that uses the integration layer runs at least two processes:

| Process    | Runs                                  | Why separate                                                             |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------ |
| **API**    | HTTP, the bus, publishers             | Scales with request volume                                               |
| **Worker** | Job worker, webhook worker, scheduler | Scales with queue depth, and a long job must not tie up a request thread |

Both connect to the same database. That is the coordination mechanism: leases, atomic claims and
unique constraints, rather than a second piece of infrastructure to operate.

Running the workers inside the API process works and is fine for a small deployment. It stops being
fine when a job takes ninety seconds and the API cannot restart without losing it.

## Wiring an application

```ts
// apps/api/src/app.module.ts
@Module({
  imports: [
    EventBusModule.forRoot({
      schemas: APPLICATION_EVENTS, // yours, alongside the framework's
      deadLetters: new PrismaDeadLetterStore(prisma),
      ledger: new PrismaDeliveryLedger(prisma),
      logger,
      metrics,
    }),
  ],
})
export class AppModule {}
```

```ts
// apps/api/src/main.ts
const app = await NestFactory.create(AppModule);

// Without this, Nest never signals shutdown and the bus never drains — in-flight handlers die
// with the process.
app.enableShutdownHooks();

await app.listen(3000);
```

```ts
// apps/worker/src/main.ts
const jobs = new JobWorker({ store: jobStore, registry: jobRegistry, concurrency: 5 });
const webhooks = new WebhookWorker({ deliveries, webhooks: webhookService });
const scheduler = new Scheduler({ store: scheduleStore, queue });

// The dispatcher is what turns published events into webhook deliveries.
bus.subscribe(dispatcher.subscriptionOptions(['**']));

jobs.start();
webhooks.start();
scheduler.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    await Promise.all([jobs.stop(), webhooks.stop(), scheduler.stop(), bus.drain()]);
    process.exit(0);
  });
}
```

## A worked example

A merchant is onboarded. Everything downstream is automatic.

```ts
// 1. The service publishes a fact. It does not know or care who is listening.
await bus.publish(
  buildEvent({
    name: 'merchant.onboarded',
    payload: { merchantId: merchant.id, tier: 'standard', organizationId: org.id },
    organizationId: org.id,
    actor,
    aggregate: { type: 'Merchant', id: merchant.id },
    source: 'merchant-api',
    correlationId: request.correlationId,
  }),
);
```

What happens next, without the service knowing:

```
merchant.onboarded published
   │
   ├─▶ welcome-email subscriber ──▶ enqueues job `mail.welcome`
   │                                   └─▶ worker sends it, retries on failure
   │
   ├─▶ webhook dispatcher ──▶ one delivery per subscribed partner endpoint
   │                             └─▶ signed, retried, dead-lettered on give-up
   │
   └─▶ audit subscriber ──▶ writes an audit record
```

Add a partner integration later and no existing code changes:

```bash
POST /webhooks/endpoints
{ "url": "https://partner.example.com/hooks", "events": ["merchant.onboarded"] }
```

That is the whole point of the layer: the publisher stated a fact, and the consumers are a
deployment concern.

## Import and export

Both run as jobs, because both are long and both need progress and history.

```ts
// Import: preview first. Always.
const { run, sample, unknownColumns } = await imports.preview({
  type: 'merchant.bulk',
  format: 'csv',
  fileName: file.name,
  content: file.buffer,
  organizationId: org.id,
  actorId: actor.id,
});

// `unknownColumns` is where a typo surfaces: `emial` in that list is the whole explanation for
// why every row is missing its email.

if (run.rowsRejected === 0) {
  await queue.enqueue({
    type: 'import.apply',
    payload: { importId: run.id },
    organizationId: org.id,
    idempotencyKey: `import:${run.checksum}`, // re-uploading the same file does nothing
  });
}
```

```ts
// Export: streams, never assembles.
await exports.run({
  type: 'merchant.list',
  format: 'csv',
  organizationId: org.id,
  params: { status: 'active' },
  sink: new HttpResponseSink(response),
  actorId: actor.id,
});
```

An export source **must** page with a cursor, not an offset. With `OFFSET`, a row inserted during a
five-minute export shifts every later page by one, so a row is silently skipped and the file is
quietly wrong in a way nobody can detect from it.

## Generating API clients

```bash
trustos generate client --spec openapi.json --target typescript --out ./clients/ts
trustos generate client --spec openapi.json --target dart       --out ./mobile/lib/api
trustos generate client --spec openapi.json --target python     --out ./scripts/client
```

Six targets: TypeScript, JavaScript, Dart, Python, Java, C#. Every generated client has the same
shape — authentication configured once, retry with jittered backoff, a typed error carrying the
server's code, request and response hooks — and **no runtime dependencies** in any target.

Unsupported OpenAPI constructs are _reported_, not silently dropped. A client missing an endpoint is
a bug found at runtime by whoever tries to call it.

## Health and monitoring

```bash
GET /health/integrations
```

```json
{
  "status": "warning",
  "checks": [
    { "key": "events.dead_letters", "status": "healthy", "detail": "No unreplayed dead letters." },
    { "key": "jobs.queue", "status": "healthy", "detail": "3 queued, 2 running." },
    {
      "key": "webhooks.delivery",
      "status": "warning",
      "detail": "412 deliveries pending; the oldest has waited 14 minutes."
    }
  ],
  "problems": [
    {
      "key": "webhooks.delivery",
      "status": "warning",
      "detail": "412 deliveries pending; the oldest has waited 14 minutes.",
      "remediation": "Deliveries are behind. If this does not clear, add worker capacity."
    }
  ]
}
```

Two rules behind that output:

- **The worst check wins.** An average would show "mostly healthy" during an outage.
- **503 only for `critical`.** A load balancer must not remove a pod because a webhook queue is
  backing up — the pod is serving fine, and removing it makes the backlog worse.

Offline, against a checkout:

```bash
trustos doctor integrations
```

## Operational runbook

| Symptom                          | First thing to check                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| Webhooks not arriving            | Is the worker running? `trustos doctor integrations`                          |
| Every signature rejected         | The receiver is verifying a re-serialized body                                |
| Jobs queued, nothing running     | The worker process was never started. The health check says this explicitly.  |
| A schedule never fires           | Its job type is registered? Is the schedule disabled after ten failures?      |
| Schedule fires twice             | Two schedulers _and_ a non-atomic `claimDue`. Check the store implementation. |
| Dead letters accumulating        | A handler is broken. Fix it, then replay — the events are not lost.           |
| Sync stopped                     | The connection is paused after five failures. Read `lastError`, fix, resume.  |
| An export is wrong but plausible | The source is paging with `OFFSET` rather than a cursor.                      |

---

**See also:** [integration-architecture.md](integration-architecture.md) ·
[scheduler.md](scheduler.md) · [webhooks.md](webhooks.md) ·
[integration-security.md](integration-security.md)
