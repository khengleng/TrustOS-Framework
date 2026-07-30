import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EventRegistry, type EventSchemaDefinition } from '@trustos/event-registry';
import { buildEvent, type EventActor, type EventEnvelope } from '@trustos/event-sdk';
import { RETRY_PRESETS, retryPolicySchema } from '@trustos/retry';
import { InMemoryEventBus, isInScope } from './in-memory-bus';
import { InMemoryDeadLetterStore, InMemoryDeliveryLedger } from './stores';
import { DeadLetterReplayService } from './replay';
import type { EventHandlerContext } from './contracts';

const actor: EventActor = { id: 'usr_1', type: 'user', roles: [] };

const SCHEMAS: EventSchemaDefinition[] = [
  {
    name: 'test.thing.created',
    version: '1',
    description: 'A thing was created.',
    payload: z.object({ thingId: z.string(), organizationId: z.string().nullable() }).strict(),
  },
  {
    name: 'test.thing.updated',
    version: '1',
    description: 'A thing was updated.',
    payload: z.object({ thingId: z.string(), organizationId: z.string().nullable() }).strict(),
  },
  {
    name: 'test.other.happened',
    version: '1',
    description: 'Something else happened.',
    payload: z.object({ organizationId: z.string().nullable() }).strict(),
  },
];

/** Retry with no waiting, so a test that exercises the retry path still finishes in a millisecond. */
const FAST_RETRY = retryPolicySchema.parse({ maxAttempts: 2, initialDelayMs: 0, jitter: 'none' });

let counter = 0;

function event(
  name: string,
  overrides: {
    organizationId?: string | null;
    aggregate?: { type: string; id: string } | null;
    payload?: Record<string, unknown>;
  } = {},
): EventEnvelope {
  const organizationId =
    overrides.organizationId === undefined ? 'org_1' : overrides.organizationId;

  return buildEvent(
    {
      name,
      payload: { ...(overrides.payload ?? { thingId: 'thing_1' }), organizationId },
      organizationId,
      actor,
      source: 'test',
      aggregate: overrides.aggregate ?? null,
    },
    { newId: () => `evt_${++counter}` },
  );
}

function makeBus(overrides: Partial<ConstructorParameters<typeof InMemoryEventBus>[0]> = {}) {
  return new InMemoryEventBus({ registry: new EventRegistry(SCHEMAS), ...overrides });
}

beforeEach(() => {
  counter = 0;
});

describe('publish and subscribe', () => {
  it('delivers a matching event', async () => {
    const bus = makeBus();
    const seen: string[] = [];

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      handler: ({ event: received }) => {
        seen.push(received.name);
      },
    });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    expect(seen).toEqual(['test.thing.created']);
  });

  it('delivers to a wildcard subscriber', async () => {
    const bus = makeBus();
    const seen: string[] = [];

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.*'],
      handler: ({ event: received }) => {
        seen.push(received.name);
      },
    });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });
    await bus.publish(event('test.thing.updated'), { awaitDelivery: true });
    await bus.publish(event('test.other.happened', { payload: {} }), { awaitDelivery: true });

    expect(seen).toEqual(['test.thing.created', 'test.thing.updated']);
  });

  it('reports zero matches without treating it as an error', async () => {
    // An event nobody subscribes to yet is the normal state of a system publishing facts.
    const result = await makeBus().publish(event('test.thing.created'));

    expect(result.matched).toBe(0);
  });

  it('refuses to publish an unregistered event', async () => {
    const bus = makeBus();
    const unregistered = { ...event('test.thing.created'), name: 'test.unknown.thing' };

    await expect(bus.publish(unregistered)).rejects.toThrow();
  });

  it('refuses to publish a payload that does not match its schema', async () => {
    const bus = makeBus();
    const bad = { ...event('test.thing.created'), payload: { wrong: true } };

    await expect(bus.publish(bad)).rejects.toThrow();
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = makeBus();
    const handler = vi.fn();

    const subscription = bus.subscribe({ id: 'sub_1', events: ['test.thing.created'], handler });
    subscription.unsubscribe();

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a duplicate subscription id, which would share a deduplication ledger', () => {
    const bus = makeBus();
    bus.subscribe({ id: 'sub_1', events: ['test.thing.created'], handler: () => {} });

    expect(() =>
      bus.subscribe({ id: 'sub_1', events: ['test.thing.updated'], handler: () => {} }),
    ).toThrow(/already exists/);
  });

  it('refuses a subscription to an event that does not exist, because the failure is silence', () => {
    const bus = makeBus();

    expect(() =>
      bus.subscribe({ id: 'sub_1', events: ['test.typo.here'], handler: () => {} }),
    ).toThrow(/subscription refers to unregistered events/i);
  });

  it('allows a wildcard that matches nothing yet, which is deliberately open-ended', () => {
    const bus = makeBus();

    expect(() =>
      bus.subscribe({ id: 'sub_1', events: ['future.**'], handler: () => {} }),
    ).not.toThrow();
  });

  it('refuses a subscription with no patterns', () => {
    expect(() => makeBus().subscribe({ id: 'sub_1', events: [], handler: () => {} })).toThrow();
  });
});

describe('tenant isolation', () => {
  it('does not deliver one organization’s event to another’s subscriber', async () => {
    const bus = makeBus();
    const handler = vi.fn();

    bus.subscribe({
      id: 'sub_org_a',
      events: ['test.**'],
      scope: { kind: 'organization', organizationId: 'org_a' },
      handler,
    });

    await bus.publish(event('test.thing.created', { organizationId: 'org_b' }), {
      awaitDelivery: true,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers an organization’s own event', async () => {
    const bus = makeBus();
    const handler = vi.fn();

    bus.subscribe({
      id: 'sub_org_a',
      events: ['test.**'],
      scope: { kind: 'organization', organizationId: 'org_a' },
      handler,
    });

    await bus.publish(event('test.thing.created', { organizationId: 'org_a' }), {
      awaitDelivery: true,
    });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not deliver a platform event to a tenant subscriber', async () => {
    // A tenant-scoped handler receiving an event with no tenant has nothing to scope its work
    // to, which is precisely how one tenant's job ends up processing another's data.
    const bus = makeBus();
    const handler = vi.fn();

    bus.subscribe({
      id: 'sub_org_a',
      events: ['test.**'],
      scope: { kind: 'organization', organizationId: 'org_a' },
      handler,
    });

    await bus.publish(event('test.thing.created', { organizationId: null }), {
      awaitDelivery: true,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers everything to a platform subscriber', async () => {
    const bus = makeBus();
    const handler = vi.fn();

    bus.subscribe({ id: 'sub_platform', events: ['test.**'], handler });

    await bus.publish(event('test.thing.created', { organizationId: 'org_a' }), {
      awaitDelivery: true,
    });
    await bus.publish(event('test.thing.created', { organizationId: null }), {
      awaitDelivery: true,
    });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, { kind: 'platform' as const }, true],
    ['org_a', { kind: 'platform' as const }, true],
    ['org_a', { kind: 'organization' as const, organizationId: 'org_a' }, true],
    ['org_b', { kind: 'organization' as const, organizationId: 'org_a' }, false],
    [null, { kind: 'organization' as const, organizationId: 'org_a' }, false],
  ])('isInScope(%s, %o) is %s', (organizationId, scope, expected) => {
    expect(isInScope(organizationId, scope)).toBe(expected);
  });
});

describe('ordering', () => {
  it('delivers two events about one aggregate in order, even with a slow first handler', async () => {
    const bus = makeBus();
    const order: string[] = [];

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.*'],
      handler: async ({ event: received }) => {
        // The first handler takes longer. Without ordering the second would finish first.
        const delay = received.name.endsWith('created') ? 20 : 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(received.name);
      },
    });

    const aggregate = { type: 'Thing', id: 'thing_1' };
    await bus.publishBatch(
      [event('test.thing.created', { aggregate }), event('test.thing.updated', { aggregate })],
      { awaitDelivery: true },
    );

    expect(order).toEqual(['test.thing.created', 'test.thing.updated']);
  });

  it('does not serialise events about different aggregates', async () => {
    const bus = makeBus();
    let concurrent = 0;
    let peak = 0;

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      concurrency: 4,
      handler: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
      },
    });

    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        bus.publish(event('test.thing.created', { aggregate: { type: 'Thing', id } }), {
          awaitDelivery: true,
        }),
      ),
    );

    // A total order across the system would be a throughput ceiling nobody asked for.
    expect(peak).toBeGreaterThan(1);
  });

  it('keeps the chain alive after a failure, so the next event still gets its turn', async () => {
    const bus = makeBus({ deadLetters: new InMemoryDeadLetterStore() });
    const seen: string[] = [];

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.*'],
      retry: RETRY_PRESETS.none,
      handler: ({ event: received }) => {
        seen.push(received.name);
        if (received.name.endsWith('created')) throw new Error('handler is broken');
      },
    });

    const aggregate = { type: 'Thing', id: 'thing_1' };
    await bus.publishBatch(
      [event('test.thing.created', { aggregate }), event('test.thing.updated', { aggregate })],
      { awaitDelivery: true },
    );

    // A rejection that poisoned the chain would starve every later event for this aggregate.
    expect(seen).toEqual(['test.thing.created', 'test.thing.updated']);
  });

  it('does not let one subscriber’s chain block another’s', async () => {
    const bus = makeBus();
    const finished: string[] = [];

    bus.subscribe({
      id: 'slow',
      events: ['test.thing.created'],
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        finished.push('slow');
      },
    });

    bus.subscribe({
      id: 'fast',
      events: ['test.thing.created'],
      handler: () => {
        finished.push('fast');
      },
    });

    await bus.publish(event('test.thing.created', { aggregate: { type: 'Thing', id: 'a' } }), {
      awaitDelivery: true,
    });

    expect(finished).toEqual(['fast', 'slow']);
  });
});

describe('failure handling', () => {
  it('does not fail the publish when a subscriber throws', async () => {
    const bus = makeBus({ deadLetters: new InMemoryDeadLetterStore() });

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      retry: RETRY_PRESETS.none,
      handler: () => {
        throw new Error('handler is broken');
      },
    });

    // A publisher is reporting a fact that already happened. One subscriber's bug must not turn
    // that into a 500 for work that succeeded.
    const result = await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    expect(result.failed).toBe(1);
  });

  it('fails the publish when a blocking subscriber throws', async () => {
    const bus = makeBus({ deadLetters: new InMemoryDeadLetterStore() });

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      blocking: true,
      retry: RETRY_PRESETS.none,
      handler: () => {
        throw new Error('gate refused');
      },
    });

    const result = await bus.publish(event('test.thing.created'));

    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(0);
  });

  it('retries before giving up', async () => {
    const bus = makeBus({ deadLetters: new InMemoryDeadLetterStore() });
    const attempts: number[] = [];

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      retry: FAST_RETRY,
      handler: ({ attempt }) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error('transient');
      },
    });

    const result = await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    expect(attempts).toEqual([1, 2, 3]);
    expect(result.delivered).toBe(1);
  });

  it('dead-letters after exhausting retries', async () => {
    const deadLetters = new InMemoryDeadLetterStore();
    const bus = makeBus({ deadLetters });

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      retry: FAST_RETRY,
      handler: () => {
        throw new Error('permanently broken');
      },
    });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    const entries = await deadLetters.list({});
    expect(entries).toHaveLength(1);
    // The handler's own message, not "retry exhausted" — the wrapper tells an operator nothing
    // they can act on.
    expect(entries[0]?.error).toBe('permanently broken');
    expect(entries[0]?.subscriptionId).toBe('sub_1');
    expect(entries[0]?.attempts).toBe(3);
  });

  it('redacts the envelope it dead-letters', async () => {
    // A dead letter is the longest-lived copy of an event in the system, often exported into a
    // ticket. A secret that reaches it has reached everywhere.
    const registry = new EventRegistry([
      {
        name: 'test.secret.leaked',
        version: '1',
        description: 'A payload with a secret-named field.',
        payload: z.object({ password: z.string(), organizationId: z.string().nullable() }),
      },
    ]);
    const deadLetters = new InMemoryDeadLetterStore();
    const bus = new InMemoryEventBus({ registry, deadLetters });

    bus.subscribe({
      id: 'sub_1',
      events: ['test.secret.leaked'],
      retry: RETRY_PRESETS.none,
      handler: () => {
        throw new Error('boom');
      },
    });

    await bus.publish(
      buildEvent({
        name: 'test.secret.leaked',
        payload: { password: 'hunter2', organizationId: 'org_1' },
        organizationId: 'org_1',
        actor,
        source: 'test',
      }),
      { awaitDelivery: true },
    );

    const [entry] = await deadLetters.list({});
    expect((entry?.envelope.payload as Record<string, string>).password).toBe('[REDACTED]');
  });

  it('logs loudly when there is nowhere to dead-letter to', async () => {
    // An event that failed and vanished is invisible data loss.
    const error = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error,
      fatal: vi.fn(),
      child: vi.fn(),
    };
    const bus = makeBus({ logger: logger as never });

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      retry: RETRY_PRESETS.none,
      handler: () => {
        throw new Error('boom');
      },
    });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    expect(error.mock.calls.map(([, message]) => message).join(' ')).toMatch(/this event is lost/i);
  });

  it('survives a dead-letter store that itself fails', async () => {
    const bus = makeBus({
      deadLetters: {
        record: async () => {
          throw new Error('the store is down too');
        },
        list: async () => [],
        get: async () => null,
        markReplayed: async () => {},
      },
    });

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      retry: RETRY_PRESETS.none,
      handler: () => {
        throw new Error('boom');
      },
    });

    await expect(
      bus.publish(event('test.thing.created'), { awaitDelivery: true }),
    ).resolves.toMatchObject({ failed: 1 });
  });
});

describe('deduplication', () => {
  it('suppresses a repeat delivery when a ledger is configured', async () => {
    const bus = makeBus({ ledger: new InMemoryDeliveryLedger() });
    const handler = vi.fn();

    bus.subscribe({ id: 'sub_1', events: ['test.thing.created'], handler });

    const envelope = event('test.thing.created');
    await bus.publish(envelope, { awaitDelivery: true });
    await bus.publish(envelope, { awaitDelivery: true });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('gives each subscriber its own chance at the event', async () => {
    const bus = makeBus({ ledger: new InMemoryDeliveryLedger() });
    const first = vi.fn();
    const second = vi.fn();

    bus.subscribe({ id: 'sub_1', events: ['test.thing.created'], handler: first });
    bus.subscribe({ id: 'sub_2', events: ['test.thing.created'], handler: second });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('delivers anyway when the ledger is unavailable', async () => {
    // A duplicate is the failure a handler is already told to expect. Dropping the event because
    // the bookkeeping is down would trade that for silent data loss.
    const bus = makeBus({
      ledger: {
        markHandled: async () => {
          throw new Error('ledger is down');
        },
        forgetOlderThan: async () => 0,
      },
    });
    const handler = vi.fn();

    bus.subscribe({ id: 'sub_1', events: ['test.thing.created'], handler });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('exposes the deduplication key to the handler', async () => {
    const bus = makeBus();
    let context: EventHandlerContext | null = null;

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      handler: (received) => {
        context = received;
      },
    });

    const envelope = event('test.thing.created');
    await bus.publish(envelope, { awaitDelivery: true });

    expect(context!.deduplicationKey).toBe(`sub_1:${envelope.idempotencyKey}`);
  });
});

describe('concurrency', () => {
  it('runs one at a time by default, because a handler that does not know it is concurrent is the common case', async () => {
    const bus = makeBus();
    let concurrent = 0;
    let peak = 0;

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      handler: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
      },
    });

    await Promise.all(
      Array.from({ length: 5 }, () =>
        bus.publish(event('test.thing.created'), { awaitDelivery: true }),
      ),
    );

    expect(peak).toBe(1);
  });

  it('honours a higher limit without exceeding it', async () => {
    const bus = makeBus();
    let concurrent = 0;
    let peak = 0;

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      concurrency: 3,
      handler: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
      },
    });

    await Promise.all(
      Array.from({ length: 10 }, () =>
        bus.publish(event('test.thing.created'), { awaitDelivery: true }),
      ),
    );

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('drain', () => {
  it('waits for an in-flight handler that publish did not await', async () => {
    const bus = makeBus();
    let finished = false;

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      },
    });

    await bus.publish(event('test.thing.created'));
    expect(finished).toBe(false);

    await bus.drain();

    // Without this, a process exits with handlers mid-flight and the events they were working on
    // are lost — which looks exactly like a bug in the handler.
    expect(finished).toBe(true);
  });

  it('refuses new events once draining', async () => {
    const bus = makeBus();
    await bus.drain();

    await expect(bus.publish(event('test.thing.created'))).rejects.toThrow(/shutting down/);
  });

  it('gives up on a handler that ignores its signal rather than hanging', async () => {
    const bus = makeBus();

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      handler: () => new Promise(() => {}),
    });

    await bus.publish(event('test.thing.created'));

    const startedAt = Date.now();
    await bus.drain(60);

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe('load', () => {
  it('delivers a thousand events to three subscribers without loss', async () => {
    const bus = makeBus();
    const counts = { a: 0, b: 0, c: 0 };

    for (const key of ['a', 'b', 'c'] as const) {
      bus.subscribe({
        id: `sub_${key}`,
        events: ['test.thing.created'],
        concurrency: 8,
        handler: () => {
          counts[key] += 1;
        },
      });
    }

    const events = Array.from({ length: 1000 }, () => event('test.thing.created'));
    await Promise.all(events.map((envelope) => bus.publish(envelope)));
    await bus.drain();

    expect(counts).toEqual({ a: 1000, b: 1000, c: 1000 });
  });

  it('keeps no ordering state once the aggregates have drained', async () => {
    // The leak this guards: one map entry per aggregate ever seen, invisible until a month in.
    const bus = makeBus();

    bus.subscribe({ id: 'sub_1', events: ['test.thing.created'], handler: () => {} });

    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        bus.publish(
          event('test.thing.created', { aggregate: { type: 'Thing', id: `t_${index}` } }),
          {
            awaitDelivery: true,
          },
        ),
      ),
    );
    await bus.drain();

    expect((bus as unknown as { orderingChains: Map<string, unknown> }).orderingChains.size).toBe(
      0,
    );
  });
});

describe('dead-letter replay', () => {
  async function setup() {
    const deadLetters = new InMemoryDeadLetterStore();
    const bus = makeBus({ deadLetters });
    let shouldFail = true;
    const handled: string[] = [];

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      retry: RETRY_PRESETS.none,
      handler: ({ event: received }) => {
        if (shouldFail) throw new Error('broken');
        handled.push(received.id);
      },
    });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });

    const service = new DeadLetterReplayService({ bus, store: deadLetters });
    const [entry] = await deadLetters.list({});

    return { bus, deadLetters, service, entry: entry!, handled, fix: () => (shouldFail = false) };
  }

  it('re-delivers after the handler is fixed', async () => {
    const { service, entry, handled, fix } = await setup();
    fix();

    const result = await service.replay(entry.id, {
      actorId: 'usr_admin',
      organizationId: 'org_1',
    });

    expect(result.outcome).toBe('delivered');
    expect(handled).toHaveLength(1);
  });

  it('is not suppressed by the delivery ledger', async () => {
    // The most confusing possible outcome: a replay that silently does nothing because the
    // original delivery is already recorded under the same key.
    const deadLetters = new InMemoryDeadLetterStore();
    const bus = makeBus({ deadLetters, ledger: new InMemoryDeliveryLedger() });
    let shouldFail = true;
    const handled: string[] = [];

    bus.subscribe({
      id: 'sub_1',
      events: ['test.thing.created'],
      retry: RETRY_PRESETS.none,
      handler: ({ event: received }) => {
        if (shouldFail) throw new Error('broken');
        handled.push(received.id);
      },
    });

    await bus.publish(event('test.thing.created'), { awaitDelivery: true });
    shouldFail = false;

    const service = new DeadLetterReplayService({ bus, store: deadLetters });
    const [entry] = await deadLetters.list({});
    await service.replay(entry!.id, { actorId: 'usr_admin', organizationId: 'org_1' });

    expect(handled).toHaveLength(1);
  });

  it('refuses a second replay of one entry', async () => {
    const { service, entry, fix } = await setup();
    fix();

    await service.replay(entry.id, { actorId: 'usr_admin', organizationId: 'org_1' });

    await expect(
      service.replay(entry.id, { actorId: 'usr_admin', organizationId: 'org_1' }),
    ).rejects.toThrow(/already replayed/);
  });

  it('refuses a cross-tenant replay, and does not confirm the entry exists', async () => {
    const { service, entry } = await setup();

    // Not-found rather than forbidden: "forbidden" would confirm another tenant's entry exists.
    await expect(
      service.replay(entry.id, { actorId: 'usr_other', organizationId: 'org_2' }),
    ).rejects.toThrow(/No dead-letter entry/);
  });

  it('lets platform staff replay any entry', async () => {
    const { service, entry, fix } = await setup();
    fix();

    await expect(
      service.replay(entry.id, { actorId: 'usr_platform', organizationId: null }),
    ).resolves.toMatchObject({ outcome: 'delivered' });
  });

  it('keeps the entry after replay, because the failure happened', async () => {
    const { service, deadLetters, entry, fix } = await setup();
    fix();

    await service.replay(entry.id, { actorId: 'usr_admin', organizationId: 'org_1' });

    const stored = await deadLetters.get(entry.id);
    expect(stored).not.toBeNull();
    expect(stored?.replayedAt).toBeInstanceOf(Date);
    expect(stored?.replayedById).toBe('usr_admin');
  });

  it('records an audit entry naming the actor', async () => {
    // Replay is a privileged action and is never anonymous, so it has its own audit record
    // rather than relying on whatever the republished event happens to carry.
    const { entry } = await setup();
    const record = vi.fn();

    const store = new InMemoryDeadLetterStore();
    await store.record(entry);

    const service = new DeadLetterReplayService({ bus: makeBus(), store, audit: { record } });

    await service.replay(entry.id, { actorId: 'usr_admin', organizationId: 'org_1' });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'event.dead_letter.replayed', actorId: 'usr_admin' }),
    );
  });

  it('reports one failure per bad entry rather than abandoning the batch', async () => {
    const { service, entry, fix } = await setup();
    fix();

    const results = await service.replayBatch([entry.id, 'dlq_missing'], {
      actorId: 'usr_admin',
      organizationId: 'org_1',
    });

    expect(results[0]?.outcome).toBe('delivered');
    expect(results[1]?.outcome).toBe('failed');
  });

  it('refuses an oversized batch, which would be a load test against the failing downstream', async () => {
    const { service } = await setup();

    await expect(
      service.replayBatch(
        Array.from({ length: 200 }, (_, index) => `dlq_${index}`),
        {
          actorId: 'usr_admin',
          organizationId: 'org_1',
        },
      ),
    ).rejects.toThrow(/Too many entries/);
  });

  it('summarises unreplayed entries by subscription and event', async () => {
    const { service } = await setup();

    const summary = await service.summary('org_1');

    expect(summary).toEqual([
      expect.objectContaining({
        subscriptionId: 'sub_1',
        eventName: 'test.thing.created',
        count: 1,
      }),
    ]);
  });
});

describe('the in-memory stores', () => {
  it('distinguishes "no organization filter" from "platform events only"', async () => {
    const store = new InMemoryDeadLetterStore();
    const base = {
      subscriptionId: 'sub_1',
      eventId: 'evt_1',
      eventName: 'test.thing.created',
      eventVersion: '1',
      envelope: event('test.thing.created'),
      attempts: 1,
      error: 'boom',
      failedAt: new Date(),
      replayedAt: null,
      replayedById: null,
    };

    await store.record({ ...base, id: 'a', organizationId: 'org_1' });
    await store.record({ ...base, id: 'b', organizationId: null });

    expect(await store.list({})).toHaveLength(2);
    expect(await store.list({ organizationId: null })).toHaveLength(1);
    expect(await store.list({ organizationId: 'org_1' })).toHaveLength(1);
  });

  it('bounds the ledger rather than growing forever', async () => {
    const ledger = new InMemoryDeliveryLedger(10);

    for (let index = 0; index < 100; index += 1) {
      await ledger.markHandled(`key_${index}`, { id: `evt_${index}`, name: 'test.thing.created' });
    }

    expect(ledger.size).toBeLessThanOrEqual(10);
  });

  it('reports the first call as first and the second as a repeat', async () => {
    const ledger = new InMemoryDeliveryLedger();
    const event = { id: 'evt_1', name: 'test.thing.created' };

    expect(await ledger.markHandled('key', event)).toBe(true);
    expect(await ledger.markHandled('key', event)).toBe(false);
  });
});
