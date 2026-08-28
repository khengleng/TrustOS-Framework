import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  buildSignatureHeader,
  isGoneStatus,
  isRetryableStatus,
  isSuccessStatus,
} from '@trustos/webhooks';
import { checkDestination, type DestinationPolicy } from './destination';

/**
 * Sending one webhook.
 *
 * A single function with no retry, no persistence and no worker loop. Those live in `worker.ts`,
 * so this can be called directly to test an endpoint from an admin UI — "send a test event" is
 * the first thing an integrator asks for and it should not require a queue.
 *
 * The delivery-time decisions, each of which has a failure mode behind it:
 *
 *   * **The destination is re-checked here**, not only at registration. DNS changes; a hostname
 *     that resolved to a public address last week can resolve to `10.0.0.1` today.
 *   * **Redirects are never followed.** A `302 → http://169.254.169.254/` would bypass the check
 *     above entirely, because the check happened before the request went out.
 *   * **The response body is read with a cap.** A receiver returning an unbounded stream would
 *     otherwise exhaust the sender's memory — a denial of service against the sender, triggered
 *     by the receiver, which is a strange direction for an attack and exactly why it gets missed.
 *   * **The timeout aborts the request**, not just the wait. A resolved race leaves the socket
 *     open, and at scale that is a connection pool that never drains.
 */

export interface DeliveryRequest {
  deliveryId: string;
  url: string;
  /** The exact bytes to send and to sign. Never re-serialized between signing and sending. */
  body: string;
  eventName: string;
  /** Active secrets, newest first. More than one during a rotation. */
  secrets: readonly string[];
  timeoutMs?: number;
  destinationPolicy?: DestinationPolicy;
  /** Extra headers. Cannot override the signature headers — see `buildHeaders`. */
  headers?: Record<string, string>;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export interface DeliveryOutcome {
  succeeded: boolean;
  responseStatus: number | null;
  responseBody: string | null;
  durationMs: number;
  error: string | null;
  /** Whether another attempt is worth making. */
  retryable: boolean;
  /** The receiver said stop — a 410. The endpoint is disabled rather than retried. */
  gone: boolean;
}

/** The most of a response body that is read and stored. */
export const MAX_RESPONSE_BYTES = 4000;

/** Default per-attempt timeout. Generous for a webhook, short enough not to tie up a worker. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export async function deliverWebhook(request: DeliveryRequest): Promise<DeliveryOutcome> {
  const now = request.now ?? (() => Date.now());
  const startedAt = now();
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const destination = await checkDestination(request.url, request.destinationPolicy);

  if (!destination.allowed) {
    return {
      succeeded: false,
      responseStatus: null,
      responseBody: null,
      durationMs: now() - startedAt,
      error: `Destination refused: ${destination.reason}`,
      // Not retryable. The address will not become public on the next attempt, and retrying is
      // just repeated probing of an internal address.
      retryable: false,
      gone: false,
    };
  }

  const timestamp = Math.floor(now() / 1000);
  const headers = buildHeaders(request, timestamp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const doFetch = request.fetchImpl ?? fetch;
    const response = await doFetch(request.url, {
      method: 'POST',
      headers,
      body: request.body,
      signal: controller.signal,
      // A redirect from a webhook receiver is either a misconfiguration or an attempt to bounce
      // a signed payload somewhere the endpoint owner never registered.
      redirect: 'manual',
    });

    const responseBody = await readCapped(response);
    const durationMs = now() - startedAt;

    if (isSuccessStatus(response.status)) {
      return {
        succeeded: true,
        responseStatus: response.status,
        responseBody,
        durationMs,
        error: null,
        retryable: false,
        gone: false,
      };
    }

    const gone = isGoneStatus(response.status);

    return {
      succeeded: false,
      responseStatus: response.status,
      responseBody,
      durationMs,
      error: describeStatus(response.status),
      retryable: !gone && isRetryableStatus(response.status),
      gone,
    };
  } catch (error) {
    const durationMs = now() - startedAt;
    const aborted = isAbortError(error);

    return {
      succeeded: false,
      responseStatus: null,
      responseBody: null,
      durationMs,
      error: aborted
        ? `No response within ${timeoutMs}ms.`
        : `Could not connect: ${error instanceof Error ? error.message : String(error)}`,
      // A timeout or a connection failure is exactly what retry is for.
      retryable: true,
      gone: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The request headers.
 *
 * Caller headers are applied first and the framework's overwrite them. A caller must not be able
 * to set `X-TrustOS-Signature` — supplying a signature the framework did not compute is the
 * whole game.
 */
export function buildHeaders(
  request: Pick<DeliveryRequest, 'headers' | 'secrets' | 'body' | 'eventName' | 'deliveryId'>,
  timestamp: number,
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(request.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }

  headers['content-type'] = 'application/json';
  headers['user-agent'] = 'TrustOS-Webhooks/1.0';
  headers[SIGNATURE_HEADER] = buildSignatureHeader(request.secrets, timestamp, request.body);
  headers[TIMESTAMP_HEADER] = String(timestamp);
  headers[EVENT_HEADER] = request.eventName;
  /**
   * The delivery id, so a receiver can deduplicate.
   *
   * Stable across retries of the same delivery — that is the point. A receiver that stores it and
   * ignores repeats gets exactly-once processing on top of at-least-once delivery, which is the
   * only place exactly-once can actually be implemented.
   */
  headers[DELIVERY_HEADER] = request.deliveryId;

  return headers;
}

/**
 * Reads a response body up to a cap.
 *
 * The stream is read in chunks and abandoned once the cap is reached, rather than buffering the
 * whole thing and slicing. Slicing afterwards would mean the unbounded body was already in
 * memory — which is the failure this is preventing.
 */
async function readCapped(response: Response): Promise<string | null> {
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body that fails mid-read is not worth failing the delivery over: the status code has
    // already been decided, and the body is diagnostic rather than authoritative.
    return null;
  } finally {
    // Releases the connection. Without it, a capped read leaves the socket held until GC.
    await reader.cancel().catch(() => {});
  }

  if (chunks.length === 0) return null;

  const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return combined.subarray(0, MAX_RESPONSE_BYTES).toString('utf8');
}

function describeStatus(status: number): string {
  if (status === 410) {
    return '410 Gone — the receiver is asking to stop receiving. The endpoint has been disabled.';
  }
  if (status === 401 || status === 403) {
    return `${status} — the receiver rejected the request. Check that they are verifying against the current signing secret.`;
  }
  if (status === 404) {
    return '404 — the URL does not exist at the receiver.';
  }
  if (status === 429) {
    return '429 — the receiver is rate limiting. This will be retried with backoff.';
  }
  if (status >= 300 && status < 400) {
    return `${status} — a redirect. Redirects are not followed, because they would send a signed payload to an unregistered destination. Register the final URL instead.`;
  }
  if (status >= 500) {
    return `${status} — the receiver returned a server error. This will be retried.`;
  }
  return `${status} — the receiver refused the request.`;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: string }).name === 'AbortError' ||
      (error as { name?: string }).name === 'TimeoutError')
  );
}
