# Integration architecture

Phase 6 is the layer that connects this platform to everything outside it — and to itself. Sixteen
packages, one shape: **an interface the framework defines, a default implementation that needs
nothing installed, and no provider.**

- [The shape](#the-shape)
- [How the pieces fit](#how-the-pieces-fit)
- [What is deliberately absent](#what-is-deliberately-absent)
- [Choosing a mechanism](#choosing-a-mechanism)
- [The four guarantees](#the-four-guarantees)
- [Running it](#running-it)

---

## The shape

Every package in this phase follows the same rule, and it is the rule that makes the phase
coherent rather than a pile of utilities:

> The framework ships the seam and a default that works with nothing installed. It does not ship
> the integration.

Concretely: there is an `EventBus` interface and an in-memory implementation, and no Kafka
adapter. There is a `Provider` contract and a registry, and no SMTP provider. There is a
`SyncConnector` interface and a run loop, and no Salesforce connector.

That is not incompleteness. A framework that shipped a payment adapter would be making a payment
decision for every product built on it, and the products that disagreed would carry the dependency
anyway. The seam is the deliverable; the adapter belongs to the product.

## How the pieces fit

```
                 ┌──────────────┐
   publish ─────▶│  event-bus   │──── subscribers ────▶ application handlers
                 └──────┬───────┘
                        │
                        ├──▶ webhook-runtime ──▶ HTTP POST to a registered endpoint
                        │       (signed, retried, dead-lettered)
                        │
                        └──▶ dead letters ──▶ replay

   scheduler ──── enqueues ────▶ job-runtime ──── worker ────▶ handler
                                     ▲
   import / export / sync ───────────┘  (long work runs as a job)

   adapter-framework ──▶ providers ──▶ whatever is outside
        (circuit breaker, retry, health)

   integration-health ──▶ reads all of the above ──▶ healthy | warning | critical
   integration-monitor ──▶ the numbers behind it
```

Three couplings are worth naming, because they are the ones that surprise people:

1. **A schedule does not run work.** It enqueues a job. That indirection is what makes a scheduled
   task retryable, cancellable, observable and recoverable after a crash — all through machinery
   that already exists.
2. **A webhook is a bus subscriber.** The dispatcher subscribes once, platform-scoped, and fans
   out per endpoint. Publishing an event is the only thing an application does; webhooks follow.
3. **Import, export and sync are jobs.** They are long, they fail, and they need progress and
   history. Reimplementing that in three places would produce three subtly different versions.

## What is deliberately absent

| Not shipped                                | Why                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Kafka, RabbitMQ, NATS, Redis Streams       | Choosing a broker is a deployment decision with operational consequences. `EventBus` is the seam that keeps it one. |
| Temporal, Camunda                          | A workflow engine is phase 5's territory, and a second one would be two ways to express the same thing.             |
| Any concrete provider                      | The phase boundary. See above.                                                                                      |
| Excel and PDF                              | Both need substantial dependencies. `FileParser` and `ExportFormatter` are ports.                                   |
| Kubernetes and cloud-specific integrations | The framework runs as a process. How that process is scheduled is not its business.                                 |
| AI anything                                | Not in this phase.                                                                                                  |

## Choosing a mechanism

The most common design mistake in this layer is reaching for the wrong one. The distinctions:

| You want                                          | Use                                   | Not                                            |
| ------------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| To tell the rest of the system something happened | An **event**                          | A direct service call                          |
| To tell somebody _else's_ system                  | A **webhook**                         | An event (they are not subscribed to your bus) |
| To do something slow, now                         | A **job**                             | Doing it in the request                        |
| To do something slow, later or repeatedly         | A **schedule** (which enqueues a job) | A `setTimeout`                                 |
| To call an external system                        | A **provider** through the registry   | `fetch` in a service                           |
| To move a lot of records in                       | An **import**                         | A loop of API calls                            |
| To move a lot of records out                      | An **export**                         | A query with no limit                          |
| To keep two systems agreeing                      | **Sync**                              | A nightly export and import                    |

An event is a statement of fact about the past, in the past tense: `user.created`, not
`user.create`. A name in the imperative is a command wearing an event's clothes, and it is how a
bus turns into an RPC mechanism nobody intended.

## The four guarantees

Everything else in this layer is a detail. These four are load-bearing, and each is enforced by a
mechanism rather than by care:

1. **No unregistered event is published.** The registry validates at publish time, in the
   publisher's process. A renamed payload field fails there rather than at three consumers.
2. **No duplicate webhook delivery.** A unique index on `(endpoint, event)`. Two application
   instances handling one event both try to enqueue; the database decides.
3. **No job runs twice.** A lease, renewed while the handler runs. A worker that loses its lease
   aborts and discards its outcome rather than writing a second one.
4. **No cross-tenant delivery.** Every store method takes `organizationId` explicitly and the bus
   scopes subscriptions itself. A handler that had to remember is a handler that eventually
   forgets.

Each is tested for the concurrent case, not just the happy one — see the load and race tests in
each package.

## Running it

The API process does not process queues. Something has to:

```ts
// apps/worker/src/main.ts
const jobs = new JobWorker({ store, registry });
const webhooks = new WebhookWorker({ deliveries, webhooks: webhookService });
const scheduler = new Scheduler({ store: schedules, queue });

jobs.start();
webhooks.start();
scheduler.start();

process.on('SIGTERM', async () => {
  // Waits for in-flight work. Exiting immediately leaves rows claimed by a process that no
  // longer exists, which needs a reaper to recover.
  await Promise.all([jobs.stop(), webhooks.stop(), scheduler.stop()]);
});
```

`trustos doctor integrations` warns when a module that needs a worker is installed and no worker
script exists. That warning is the single most useful line the command prints: a queue that fills
and is never drained produces no error anywhere.

---

**See also:** [events.md](events.md) · [webhooks.md](webhooks.md) · [scheduler.md](scheduler.md) ·
[provider-adapters.md](provider-adapters.md) · [synchronization.md](synchronization.md) ·
[integration-security.md](integration-security.md) · [automation.md](automation.md)
