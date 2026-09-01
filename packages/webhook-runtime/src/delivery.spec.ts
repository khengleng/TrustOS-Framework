import { describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  verifySignature,
} from '@trustsystem/webhooks';
import { MAX_RESPONSE_BYTES, buildHeaders, deliverWebhook } from './delivery';

const SECRET = 'whsec_' + 'a'.repeat(64);
const BODY = '{"id":"evt_1","name":"test.thing.created"}';
const NOW = 1_753_900_000_000;

/** A fetch double that records what it was called with. */
function fetchReturning(response: Partial<Response> & { status: number; body?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });

    return {
      status: response.status,
      body: response.body === undefined ? null : streamOf(response.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const base = {
  deliveryId: 'whdl_1',
  url: 'https://hooks.example.com/trustos',
  body: BODY,
  eventName: 'test.thing.created',
  secrets: [SECRET],
  now: () => NOW,
  // The test destination is a hostname; resolution is stubbed rather than hitting real DNS.
  destinationPolicy: { resolve: async () => ['93.184.216.34'] },
};

describe('a successful delivery', () => {
  it('POSTs the body and reports success', async () => {
    const { impl, calls } = fetchReturning({ status: 200, body: 'ok' });

    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    expect(outcome.succeeded).toBe(true);
    expect(outcome.responseStatus).toBe(200);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(BODY);
  });

  it('sends a signature the receiver can verify', async () => {
    const { impl, calls } = fetchReturning({ status: 204 });

    await deliverWebhook({ ...base, fetchImpl: impl });

    const headers = calls[0]?.init.headers as Record<string, string>;
    const result = verifySignature({
      body: BODY,
      header: headers[SIGNATURE_HEADER]!,
      secrets: [SECRET],
      now: () => NOW,
    });

    expect(result.valid).toBe(true);
  });

  it('sends the delivery id, so a receiver can deduplicate', async () => {
    const { impl, calls } = fetchReturning({ status: 200 });

    await deliverWebhook({ ...base, fetchImpl: impl });

    const headers = calls[0]?.init.headers as Record<string, string>;
    // Stable across retries of one delivery — which is what makes exactly-once processing
    // possible on the receiving side.
    expect(headers[DELIVERY_HEADER]).toBe('whdl_1');
    expect(headers[EVENT_HEADER]).toBe('test.thing.created');
  });

  it.each([200, 201, 202, 204, 299])('treats %d as success', async (status) => {
    const { impl } = fetchReturning({ status });

    expect((await deliverWebhook({ ...base, fetchImpl: impl })).succeeded).toBe(true);
  });
});

describe('headers', () => {
  it('does not let a caller override the signature', async () => {
    // Supplying a signature the framework did not compute is the whole game.
    const headers = buildHeaders(
      {
        headers: { [SIGNATURE_HEADER]: 't=1,v1=forged', 'X-Custom': 'kept' },
        secrets: [SECRET],
        body: BODY,
        eventName: 'test.thing.created',
        deliveryId: 'whdl_1',
      },
      1_753_900_000,
    );

    expect(headers[SIGNATURE_HEADER]).not.toContain('forged');
    expect(headers['x-custom']).toBe('kept');
  });

  it('normalizes caller header names, so a differently-cased override still loses', async () => {
    const headers = buildHeaders(
      {
        headers: { 'X-TrustOS-Signature': 't=1,v1=forged' },
        secrets: [SECRET],
        body: BODY,
        eventName: 'test.thing.created',
        deliveryId: 'whdl_1',
      },
      1_753_900_000,
    );

    expect(headers[SIGNATURE_HEADER]).not.toContain('forged');
  });
});

describe('failure handling', () => {
  it.each([
    [500, true],
    [502, true],
    [503, true],
    [429, true],
    [408, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
  ])('classifies %d as retryable=%s', async (status, retryable) => {
    const { impl } = fetchReturning({ status });

    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    expect(outcome.succeeded).toBe(false);
    expect(outcome.retryable).toBe(retryable);
  });

  it('treats 410 as a request to stop rather than a failure to retry', async () => {
    const { impl } = fetchReturning({ status: 410 });

    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    expect(outcome.gone).toBe(true);
    expect(outcome.retryable).toBe(false);
  });

  it('does not follow a redirect', async () => {
    const { impl, calls } = fetchReturning({ status: 302 });

    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    // A 302 → http://169.254.169.254/ would bypass every destination check, because the check
    // happened before the request went out.
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(outcome.succeeded).toBe(false);
    expect(outcome.error).toMatch(/Redirects are not followed/);
  });

  it('reports a connection failure as retryable', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    expect(outcome.retryable).toBe(true);
    expect(outcome.error).toMatch(/ECONNREFUSED/);
  });

  it('aborts a slow request rather than only losing the race', async () => {
    let receivedSignal: AbortSignal | undefined;

    const impl = (async (_url: string, init: RequestInit) => {
      receivedSignal = init.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const outcome = await deliverWebhook({
      ...base,
      fetchImpl: impl,
      timeoutMs: 20,
      now: Date.now,
    });

    // A resolved race would leave the socket open, and at scale that is a pool that never drains.
    expect(receivedSignal).toBeDefined();
    expect(outcome.error).toMatch(/No response within 20ms/);
    expect(outcome.retryable).toBe(true);
  });

  it('explains a 401 in terms of the likely cause', async () => {
    const { impl } = fetchReturning({ status: 401 });

    expect((await deliverWebhook({ ...base, fetchImpl: impl })).error).toMatch(/signing secret/);
  });
});

describe('the destination check at delivery time', () => {
  it('refuses a URL that now resolves privately, and does not retry', async () => {
    const impl = vi.fn() as unknown as typeof fetch;

    const outcome = await deliverWebhook({
      ...base,
      fetchImpl: impl,
      destinationPolicy: { resolve: async () => ['169.254.169.254'] },
    });

    // DNS changes. A check performed only at registration proves nothing about where the request
    // eventually goes.
    expect(outcome.succeeded).toBe(false);
    expect(outcome.error).toMatch(/Destination refused/);
    // Not retryable: the address will not become public on the next attempt.
    expect(outcome.retryable).toBe(false);
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('the response body', () => {
  it('is capped, so a receiver cannot exhaust the sender', async () => {
    const { impl } = fetchReturning({ status: 500, body: 'x'.repeat(MAX_RESPONSE_BYTES * 3) });

    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    expect(outcome.responseBody?.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it('stops reading an endless stream rather than buffering it', async () => {
    let produced = 0;

    const impl = (async () =>
      ({
        status: 500,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            produced += 1024;
            controller.enqueue(new Uint8Array(1024).fill(120));
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    expect(outcome.responseBody?.length).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    // The stream is abandoned rather than drained: a modest multiple of the cap, not unbounded.
    expect(produced).toBeLessThan(MAX_RESPONSE_BYTES * 4);
  });

  it('is null when there is no body', async () => {
    const { impl } = fetchReturning({ status: 204 });

    expect((await deliverWebhook({ ...base, fetchImpl: impl })).responseBody).toBeNull();
  });

  it('does not fail the delivery when the body errors mid-read', async () => {
    const impl = (async () =>
      ({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error('connection reset'));
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    // The status is already decided; the body is diagnostic rather than authoritative.
    const outcome = await deliverWebhook({ ...base, fetchImpl: impl });

    expect(outcome.succeeded).toBe(true);
    expect(outcome.responseBody).toBeNull();
  });
});
