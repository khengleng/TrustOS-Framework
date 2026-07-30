import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EventRegistry, type EventSchemaDefinition } from '@trustos/event-registry';
import { buildEvent, type EventActor } from '@trustos/event-sdk';
import { retryPolicySchema } from '@trustos/retry';
import {
  PlaintextSecretCipher,
  SIGNATURE_HEADER,
  WebhookService,
  createInMemoryWebhookStores,
  verifySignature,
} from '@trustos/webhooks';
import { WebhookDispatcher } from './dispatcher';
import { WebhookWorker } from './worker';

const actor: EventActor = { id: 'usr_1', type: 'user', roles: [] };

const SCHEMAS: EventSchemaDefinition[] = [
  {
    name: 'test.thing.created',
    version: '1',
    description: 'A thing was created.',
    payload: z.object({ thingId: z.string() }).passthrough(),
  },
  {
    name: 'test.other.happened',
    version: '1',
    description: 'Something else.',
    payload: z.object({}).passthrough(),
  },
];

/** No waiting between retries, so the retry path is exercised without the wall-clock cost. */
const FAST_RETRY = retryPolicySchema.parse({ maxAttempts: 2, initialDelayMs: 0, jitter: 'none' });

let clock = new Date('2026-07-01T10:00:00Z');
let counter = 0;

function setup() {
  const stores = createInMemoryWebhookStores(() => clock);

  const webhooks = new WebhookService({
    endpoints: stores.endpoints,
    secrets: stores.secrets,
    subscriptions: stores.subscriptions,
    cipher: new PlaintextSecretCipher(),
    registry: new EventRegistry(SCHEMAS),
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  const dispatcher = new WebhookDispatcher({
    endpoints: stores.endpoints,
    deliveries: stores.deliveries,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { stores, webhooks, dispatcher };
}

function event(name = 'test.thing.created', organizationId: string | null = 'org_1') {
  return buildEvent(
    {
      name,
      payload: { thingId: 'thing_1' },
      organizationId,
      actor,
      source: 'test',
    },
    { newId: () => `evt_${++counter}` },
  );
}

function makeWorker(
  parts: ReturnType<typeof setup>,
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof WebhookWorker>[0]> = {},
) {
  return new WebhookWorker({
    deliveries: parts.stores.deliveries,
    webhooks: parts.webhooks,
    retry: FAST_RETRY,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
    destinationPolicy: { allowPrivateAddresses: true },
    ...overrides,
    // The worker calls `fetch` through `deliverWebhook`, which the tests reach by stubbing the
    // global — the worker itself has no fetch seam, because production has no reason to want one.
  });
}

beforeEach(() => {
  clock = new Date('2026-07-01T10:00:00Z');
  counter = 0;
  vi.unstubAllGlobals();
});

/** Stubs global fetch and reports what was sent. */
function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = handler(url, init);

    return {
      status: response.status,
      body:
        response.body === undefined
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(response.body!));
                controller.close();
              },
            }),
    } as unknown as Response;
  });

  return calls;
}

describe('dispatch', () => {
  it('queues one delivery per subscribed endpoint', async () => {
    const parts = setup();
    await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url: 'https://a.example.com/hook',
      events: ['test.thing.created'],
      actorId: 'usr_1',
    });
    await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url: 'https://b.example.com/hook',
      events: ['test.thing.*'],
      actorId: 'usr_1',
    });

    const result = await parts.dispatcher.dispatch(event());

    expect(result).toMatchObject({ matched: 2, queued: 2, duplicates: 0 });
  });

  it('does not queue for an endpoint whose patterns do not match', async () => {
    const parts = setup();
    await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url: 'https://a.example.com/hook',
      events: ['test.thing.created'],
      actorId: 'usr_1',
    });

    expect(await parts.dispatcher.dispatch(event('test.other.happened'))).toMatchObject({
      matched: 0,
      queued: 0,
    });
  });

  it('never queues a duplicate for the same endpoint and event', async () => {
    // The guarantee. Two instances handling the same event both call `enqueue`; the uniqueness
    // constraint decides, not a prior read.
    const parts = setup();
    await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url: 'https://a.example.com/hook',
      events: ['test.thing.created'],
      actorId: 'usr_1',
    });

    const envelope = event();
    const first = await parts.dispatcher.dispatch(envelope);
    const second = await parts.dispatcher.dispatch(envelope);

    expect(first.queued).toBe(1);
    expect(second.queued).toBe(0);
    expect(second.duplicates).toBe(1);
    expect(parts.stores.deliveries.deliveries.size).toBe(1);
  });

  it('suppresses duplicates under concurrent dispatch', async () => {
    const parts = setup();
    await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url: 'https://a.example.com/hook',
      events: ['test.thing.created'],
      actorId: 'usr_1',
    });

    const envelope = event();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => parts.dispatcher.dispatch(envelope)),
    );

    expect(results.reduce((sum, result) => sum + result.queued, 0)).toBe(1);
    expect(parts.stores.deliveries.deliveries.size).toBe(1);
  });

  it('does not queue for another organization’s endpoint', async () => {
    const parts = setup();
    await parts.webhooks.createEndpoint({
      organizationId: 'org_2',
      url: 'https://other-tenant.example.com/hook',
      events: ['test.thing.created'],
      actorId: 'usr_other',
    });

    // A webhook reaching another tenant's endpoint is a data breach with a signature attesting
    // that it came from us.
    expect(await parts.dispatcher.dispatch(event('test.thing.created', 'org_1'))).toMatchObject({
      matched: 0,
      queued: 0,
    });
  });

  it('skips a paused endpoint without treating it as an error', async () => {
    const parts = setup();
    const created = await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url: 'https://a.example.com/hook',
      events: ['test.thing.created'],
      actorId: 'usr_1',
    });
    await parts.webhooks.setStatus(created.endpoint.id, 'org_1', 'paused', 'usr_1');

    expect(await parts.dispatcher.dispatch(event())).toMatchObject({ queued: 0, skipped: 1 });
  });

  it('redacts the body before it leaves the trust boundary', async () => {
    const parts = setup();
    await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url: 'https://a.example.com/hook',
      events: ['test.thing.created'],
      actorId: 'usr_1',
    });

    const envelope = buildEvent({
      name: 'test.thing.created',
      payload: { thingId: 't1', apiKey: 'sk_live_secret' },
      organizationId: 'org_1',
      actor,
      source: 'test',
    });

    await parts.dispatcher.dispatch(envelope);

    const [delivery] = [...parts.stores.deliveries.deliveries.values()];
    expect(delivery?.payload).toContain('[REDACTED]');
    expect(delivery?.payload).not.toContain('sk_live_secret');
  });
});

describe('the worker', () => {
  async function queued(parts: ReturnType<typeof setup>, url = 'https://hooks.example.com/x') {
    const created = await parts.webhooks.createEndpoint({
      organizationId: 'org_1',
      url,
      events: ['test.thing.created'],
      actorId: 'usr_1',
    });
    await parts.dispatcher.dispatch(event());
    return created;
  }

  it('sends a due delivery and marks it succeeded', async () => {
    const parts = setup();
    await queued(parts);
    const calls = stubFetch(() => ({ status: 200 }));

    const processed = await makeWorker(parts, fetch).tick();

    expect(processed).toBe(1);
    expect(calls).toHaveLength(1);
    expect([...parts.stores.deliveries.deliveries.values()][0]?.status).toBe('succeeded');
  });

  it('signs with the endpoint’s current secret', async () => {
    const parts = setup();
    const created = await queued(parts);
    const calls = stubFetch(() => ({ status: 200 }));

    await makeWorker(parts, fetch).tick();

    const headers = calls[0]?.init.headers as Record<string, string>;
    const [delivery] = [...parts.stores.deliveries.deliveries.values()];

    expect(
      verifySignature({
        body: delivery!.payload,
        header: headers[SIGNATURE_HEADER]!,
        secrets: [created.secret],
        now: () => clock.getTime(),
      }).valid,
    ).toBe(true);
  });

  it('schedules a retry after a 500 rather than giving up', async () => {
    const parts = setup();
    await queued(parts);
    stubFetch(() => ({ status: 500 }));

    await makeWorker(parts, fetch).tick();

    const [delivery] = [...parts.stores.deliveries.deliveries.values()];
    expect(delivery?.status).toBe('pending');
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.nextAttemptAt).not.toBeNull();
  });

  it('gives up after exhausting its attempts', async () => {
    const parts = setup();
    await queued(parts);
    stubFetch(() => ({ status: 500 }));
    const worker = makeWorker(parts, fetch);

    // FAST_RETRY allows two retries, so three attempts in total.
    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + 60_000);
      await worker.tick();
    }

    const [delivery] = [...parts.stores.deliveries.deliveries.values()];
    expect(delivery?.status).toBe('exhausted');
    expect(delivery?.attempts).toBe(3);
    expect(delivery?.nextAttemptAt).toBeNull();
  });

  it('does not retry a 400, which the receiver has understood and refused', async () => {
    const parts = setup();
    await queued(parts);
    stubFetch(() => ({ status: 400 }));

    await makeWorker(parts, fetch).tick();

    expect([...parts.stores.deliveries.deliveries.values()][0]?.status).toBe('exhausted');
  });

  it('disables the endpoint at once on a 410', async () => {
    const parts = setup();
    const created = await queued(parts);
    stubFetch(() => ({ status: 410 }));

    await makeWorker(parts, fetch).tick();

    const endpoint = await parts.webhooks.getEndpoint(created.endpoint.id, 'org_1');
    expect(endpoint.status).toBe('disabled');
    expect(endpoint.disabledReason).toMatch(/410 Gone/);
  });

  it('records an attempt row per try, so the history answers "what did you send"', async () => {
    const parts = setup();
    await queued(parts);
    stubFetch(() => ({ status: 503 }));
    const worker = makeWorker(parts, fetch);

    await worker.tick();
    clock = new Date(clock.getTime() + 60_000);
    await worker.tick();

    const [delivery] = [...parts.stores.deliveries.deliveries.values()];
    const attempts = await parts.stores.deliveries.listAttempts(delivery!.id, 'org_1');

    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(attempts.every((attempt) => attempt.responseStatus === 503)).toBe(true);
  });

  it('does not count a retryable failure against the endpoint’s health', async () => {
    const parts = setup();
    const created = await queued(parts);
    stubFetch(() => ({ status: 503 }));

    await makeWorker(parts, fetch).tick();

    // A delivery that will be retried has not failed yet. Counting each attempt would disable an
    // endpoint after two flaky deliveries rather than after twenty failed ones.
    const endpoint = await parts.webhooks.getEndpoint(created.endpoint.id, 'org_1');
    expect(endpoint.consecutiveFailures).toBe(0);
  });

  it('counts against the endpoint once the delivery is given up on', async () => {
    const parts = setup();
    const created = await queued(parts);
    stubFetch(() => ({ status: 400 }));

    await makeWorker(parts, fetch).tick();

    expect(
      (await parts.webhooks.getEndpoint(created.endpoint.id, 'org_1')).consecutiveFailures,
    ).toBe(1);
  });

  it('re-sends the identical body on a retry, so the signature still verifies', async () => {
    const parts = setup();
    await queued(parts);
    const calls = stubFetch(() => ({ status: 503 }));
    const worker = makeWorker(parts, fetch);

    await worker.tick();
    clock = new Date(clock.getTime() + 60_000);
    await worker.tick();

    // Rebuilding the body per attempt would give the receiver a different signature for what
    // they see as one delivery.
    expect(calls[0]?.init.body).toBe(calls[1]?.init.body);
  });

  it('claims a delivery only once, so two workers do not both send it', async () => {
    const parts = setup();
    await queued(parts);
    stubFetch(() => ({ status: 200 }));

    const [first, second] = await Promise.all([
      makeWorker(parts, fetch).tick(),
      makeWorker(parts, fetch).tick(),
    ]);

    expect(first + second).toBe(1);
  });

  it('fails a delivery whose endpoint has no active secret, without sending it unsigned', async () => {
    const parts = setup();
    const created = await queued(parts);

    for (const secret of parts.stores.secrets.secrets.values()) {
      parts.stores.secrets.secrets.set(secret.id, { ...secret, revokedAt: clock });
    }

    const calls = stubFetch(() => ({ status: 200 }));
    await makeWorker(parts, fetch).tick();

    // A receiver cannot verify an unsigned delivery and should not accept one, so it is never
    // sent at all.
    expect(calls).toHaveLength(0);
    const [delivery] = [...parts.stores.deliveries.deliveries.values()];
    expect(delivery?.status).toBe('exhausted');
    expect(delivery?.error).toMatch(/No active signing secret/);
    void created;
  });

  it('does not stop when the store throws mid-tick', async () => {
    const parts = setup();
    await queued(parts);
    stubFetch(() => ({ status: 200 }));

    const failing = {
      ...parts.stores.deliveries,
      claimDue: async () => {
        throw new Error('the database is down');
      },
    } as unknown as typeof parts.stores.deliveries;

    const worker = new WebhookWorker({
      deliveries: failing,
      webhooks: parts.webhooks,
      pollIntervalMs: 5,
      now: () => clock,
    });

    // A store that is briefly unavailable must not stop webhook delivery for the life of the
    // process; the symptom would be silence.
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('processes several deliveries concurrently', async () => {
    const parts = setup();
    for (const host of ['a', 'b', 'c', 'd', 'e']) {
      await parts.webhooks.createEndpoint({
        organizationId: 'org_1',
        url: `https://${host}.example.com/hook`,
        events: ['test.thing.created'],
        actorId: 'usr_1',
      });
    }
    await parts.dispatcher.dispatch(event());

    let concurrent = 0;
    let peak = 0;

    vi.stubGlobal('fetch', async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return { status: 200, body: null } as unknown as Response;
    });

    await makeWorker(parts, fetch, { concurrency: 5 }).tick();

    // One slow receiver must not hold up a hundred fast ones.
    expect(peak).toBeGreaterThan(1);
  });

  it('stops promptly rather than waiting out the poll interval', async () => {
    const parts = setup();
    const worker = makeWorker(parts, fetch, { pollIntervalMs: 5_000 });

    worker.start();
    const startedAt = Date.now();
    await worker.stop();

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
