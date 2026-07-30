# Events

An event is a statement that something happened. Past tense, validated against a registered
schema, delivered at least once, ordered per aggregate.

- [The envelope](#the-envelope)
- [Registering a schema](#registering-a-schema)
- [Publishing](#publishing)
- [Subscribing](#subscribing)
- [Ordering](#ordering)
- [Failure and dead letters](#failure-and-dead-letters)
- [Versioning an event](#versioning-an-event)
- [Replacing the bus](#replacing-the-bus)

---

## The envelope

Every event has the same outer shape. The payload is yours; the envelope is the framework's, and a
consumer can route, deduplicate and audit an event without understanding its payload at all.

```json
{
  "id": "evt_01HZ...",
  "name": "identity.user.created",
  "version": "1",
  "organizationId": "org_01HZ...",
  "actor": { "id": "usr_01HZ...", "type": "user", "roles": ["administrator"] },
  "aggregate": { "type": "User", "id": "usr_01HZ..." },
  "idempotencyKey": "evt_01HZ...",
  "occurredAt": "2026-09-01T10:00:00.000Z",
  "metadata": {
    "correlationId": "req_01HZ...",
    "causationId": null,
    "requestId": "req_01HZ...",
    "traceId": null,
    "source": "merchant-api",
    "attributes": {}
  },
  "payload": { "userId": "usr_01HZ...", "email": "dara@example.com" }
}
```

The fields that are not obvious:

| Field            | Why it exists                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `idempotencyKey` | A consumer that receives the same event twice must be able to tell. Defaults to the event id; set it from business identity (`invoice-paid:inv_123`) to make two _different_ publications of one fact deduplicate. |
| `correlationId`  | Ties the whole chain of work together, across processes. Generated when absent — an event with none breaks the chain for everything downstream.                                                                    |
| `causationId`    | The single parent event. Correlation gives you the chain; causation gives you the tree.                                                                                                                            |
| `aggregate`      | What the event is about, and the ordering key.                                                                                                                                                                     |
| `actor`          | Who did it. An event without one cannot be audited.                                                                                                                                                                |

## Registering a schema

**An event whose schema is not registered is never published.** That is the rule, and it is what
turns a bus from a place where anything can appear into a contract.

```ts
const registry = new EventRegistry(STANDARD_EVENTS);

registry.register({
  name: 'merchant.onboarded',
  version: '1',
  description: 'A merchant completed onboarding and can transact.',
  aggregateType: 'Merchant',
  payload: z
    .object({
      merchantId: z.string(),
      tier: z.enum(['standard', 'premium']),
      organizationId: z.string().nullable(),
    })
    .strict(),
  example: { merchantId: 'mch_1', tier: 'standard', organizationId: 'org_1' },
});
```

`.strict()` matters: without it, a renamed field is silently accepted as an extra property and the
consumer reading the old name gets `undefined`. The example is validated on registration, because
an example that does not parse is worse than none — it gets copied.

## Publishing

```ts
await bus.publish(
  buildEvent({
    name: 'merchant.onboarded',
    payload: { merchantId: merchant.id, tier: 'standard', organizationId: org.id },
    organizationId: org.id,
    actor: { id: actor.id, type: 'user', roles: actor.roles },
    aggregate: { type: 'Merchant', id: merchant.id },
    source: 'merchant-api',
    correlationId: request.correlationId,
  }),
);
```

`publish` returns as soon as the event is accepted, **not** when handlers finish. A publisher is
reporting something that already happened; making it wait on a subscriber couples the two in
exactly the way an event was supposed to avoid.

From inside a handler, use `deriveEvent` instead — it keeps the correlation and sets causation:

```ts
await bus.publish(deriveEvent(context.event, { name: 'merchant.welcome_queued', ... }));
```

## Subscribing

```ts
bus.subscribe({
  // Stable across restarts. A generated id makes every restart look like a new subscriber and
  // replays everything it had already handled.
  id: 'merchant-api.welcome-email',
  events: ['merchant.onboarded', 'identity.user.*'],
  scope: { kind: 'platform' },
  concurrency: 1,
  handler: async ({ event, attempt, deduplicationKey, signal }) => {
    if (await alreadyHandled(deduplicationKey)) return;
    await sendWelcome(event.payload as MerchantOnboarded);
  },
});
```

Patterns: `merchant.onboarded` exact, `identity.user.*` one segment, `workflow.**` the remainder,
`*` everything. `workflow.task` does **not** match `workflow.task.comment.added` — a subscriber
gets what it asked for and nothing wider.

**Tenant scope is enforced by the bus.** An `organization`-scoped subscriber never sees another
organization's event, and never sees a platform event either — a tenant-scoped handler receiving
an event with no tenant has nothing to scope its work to.

## Ordering

Two events about the same aggregate are delivered in order. Two about different aggregates are
not, and that is deliberate: a total order across the system is a throughput ceiling nobody asked
for.

```ts
await bus.publishBatch([
  buildEvent({ name: 'merchant.onboarded', aggregate: { type: 'Merchant', id: 'm1' }, ... }),
  buildEvent({ name: 'merchant.tier_changed', aggregate: { type: 'Merchant', id: 'm1' }, ... }),
]);
// The subscriber sees onboarded then tier_changed. Always.
```

Events with no `aggregate` are unordered and run concurrently.

## Failure and dead letters

A handler that throws is retried with the background policy. When it runs out of attempts the
event is dead-lettered — **never dropped**. An event that failed and vanished is invisible data
loss whose first symptom is a customer noticing weeks later.

The dead letter stores the _original_ error, not "retry exhausted", and the envelope is redacted
before storage: a dead letter is the longest-lived copy of an event in the system.

Replaying, after fixing the handler:

```bash
GET  /events/dead-letters?unreplayedOnly=true
POST /events/dead-letters/dlq_01HZ.../replay
```

Replay republishes through the normal path — validation, ledger, retry — so it is not a second,
less-tested delivery mechanism used at the worst possible moment. A replayed entry is marked, never
deleted: the failure happened.

A cross-tenant replay is refused, and reported as not-found rather than forbidden — "forbidden"
would confirm another tenant's entry exists.

## Versioning an event

Add a version; never change one in place.

```ts
registry.register({ name: 'merchant.onboarded', version: '1', stability: 'deprecated', supersededBy: '2', ... });
registry.register({ name: 'merchant.onboarded', version: '2', payload: newSchema, ... });
```

Publishing a deprecated version warns rather than failing. Refusing it would break a running
consumer at the moment somebody marked it deprecated — which is exactly when nothing should break.
Removal is `unregister`, which is a deliberate act.

## Replacing the bus

`InMemoryEventBus` is a single process: events in flight are lost on a crash. For most deployments
that is fine, and the alternative is an operational surface nobody asked for.

When it is not fine, implement `EventBus` over whatever transport you chose. No publisher and no
subscriber changes — that is what the interface is for. The guarantees your implementation owes
are listed in the header of `contracts.ts`, and the two that are easy to miss are ordering per
aggregate and tenant scoping.

---

**See also:** [integration-architecture.md](integration-architecture.md) ·
[webhooks.md](webhooks.md) · [integration-security.md](integration-security.md)
