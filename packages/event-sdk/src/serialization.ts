import { ApiError } from '@trustos/errors';
import { eventEnvelopeSchema, type EventEnvelope } from './envelope';

/**
 * Serialization and redaction.
 *
 * An event crosses a boundary — a queue, a webhook, a log — and two things have to be true when
 * it does: it round-trips exactly, and it carries no secret.
 *
 * The second is the harder one. A payload is publisher-supplied and an event is one of the
 * longest-lived records in the system: stored on the bus, copied into a webhook delivery, kept
 * in a dead-letter queue, and read by whoever debugs the failure in three months. A credential
 * that gets in here gets everywhere.
 */

/**
 * Field names whose values never leave the process.
 *
 * A denylist by name, and a safety net rather than a licence: a field called `data` holding a
 * token is caught by no name-based redactor. The primary control is that publishers put
 * identifiers in payloads, not credentials.
 */
export const SECRET_FIELD_PATTERNS = [
  'password',
  'secret',
  'token',
  'credential',
  'apikey',
  'privatekey',
  'authorization',
  'cookie',
  'signature',
  'passphrase',
  'pin',
  'cvv',
  'cardnumber',
  'pan',
  'accountnumber',
  'iban',
  'ssn',
];

/**
 * Names that look sensitive but are identifiers an event needs.
 *
 * Checked before the pattern match. Without this, `tokenId` and `signatureVersion` are redacted
 * and a consumer cannot correlate or verify anything — which is the same class of bug the
 * security-event redactor hit in phase 4, so the fix is the same shape.
 */
export const SAFE_IDENTIFIER_FIELDS = [
  'tokenid',
  'apikeyid',
  'credentialtype',
  'credentialprefix',
  'signatureversion',
  'signaturealgorithm',
  'idempotencykey',
  'correlationid',
];

export const REDACTED = '[REDACTED]';

export function isSecretFieldName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (SAFE_IDENTIFIER_FIELDS.includes(lowered)) return false;
  return SECRET_FIELD_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/**
 * Strips secret-named values.
 *
 * Depth-limited and cycle-safe, because it runs on publisher-supplied data — a deeply nested or
 * self-referential payload would otherwise be a stack overflow reachable by anybody who can
 * publish.
 */
export function redactPayload(value: unknown, maxDepth = 8): unknown {
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[TRUNCATED]';
    if (input === null || input === undefined) return null;

    const type = typeof input;
    if (type === 'function' || type === 'symbol') return undefined;
    if (type !== 'object') return input;
    if (input instanceof Date) return input.toISOString();

    if (seen.has(input as object)) return '[CIRCULAR]';
    seen.add(input as object);

    if (Array.isArray(input)) {
      return input.slice(0, 200).map((entry) => walk(entry, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      if (isSecretFieldName(key)) {
        output[key] = REDACTED;
        continue;
      }
      const walked = walk(entry, depth + 1);
      if (walked !== undefined) output[key] = walked;
    }
    return output;
  };

  return walk(value, 0);
}

/** The envelope with its payload redacted. What goes into a log or a dead-letter record. */
export function redactEnvelope(envelope: EventEnvelope): EventEnvelope {
  return {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      attributes: redactPayload(
        envelope.metadata.attributes,
      ) as EventEnvelope['metadata']['attributes'],
    },
    payload: redactPayload(envelope.payload),
  };
}

/**
 * The maximum serialized size of an event.
 *
 * A bound rather than a suggestion. An unbounded event is a denial of service against every
 * subscriber, a webhook body no receiver will accept, and a dead-letter row that makes the table
 * unreadable. 256 KiB is generous for a notification and far too small to smuggle a file
 * through — which is the point: a file belongs in the document module with its id in the event.
 */
export const MAX_EVENT_BYTES = 256 * 1024;

export function serializeEvent(envelope: EventEnvelope): string {
  const json = JSON.stringify(envelope);

  if (json.length > MAX_EVENT_BYTES) {
    throw ApiError.validation(
      [
        {
          path: 'payload',
          message:
            `This event serializes to ${Math.round(json.length / 1024)} KiB, over the ` +
            `${MAX_EVENT_BYTES / 1024} KiB limit. Publish an identifier and let the consumer ` +
            'fetch the data — a file belongs in the document module with its id in the event.',
          code: 'event_too_large',
        },
      ],
      'This event is too large to publish.',
    );
  }

  return json;
}

/**
 * Parses and validates an envelope.
 *
 * Throws rather than returning null, because a malformed envelope on the wire is not a
 * recoverable condition for a consumer — it is a producer bug or a corrupted transport, and
 * either way continuing with a half-understood event is worse than stopping.
 *
 * Dates come back as `Date` because the schema coerces them. A consumer comparing
 * `occurredAt` to `new Date()` against a string would silently always be false.
 */
export function deserializeEvent(json: string): EventEnvelope {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw ApiError.validation(
      [
        {
          path: 'envelope',
          message: `Not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
          code: 'event_malformed',
        },
      ],
      'This event could not be parsed.',
    );
  }

  const result = eventEnvelopeSchema.safeParse(parsed);

  if (!result.success) {
    throw ApiError.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'envelope',
        message: issue.message,
        code: 'event_invalid',
      })),
      'This event envelope is not valid.',
    );
  }

  return result.data as EventEnvelope;
}

/**
 * A stable hash of an event, for deduplication storage.
 *
 * Over the idempotency key and the payload, not the whole envelope: two publications of the same
 * fact differ in `id` and `occurredAt` but should deduplicate. Including those would make every
 * publication unique, which is the same as having no deduplication.
 */
export async function eventFingerprint(envelope: EventEnvelope): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(`${envelope.name}:${envelope.version}:${envelope.idempotencyKey}`)
    .update(stableStringify(envelope.payload))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}
