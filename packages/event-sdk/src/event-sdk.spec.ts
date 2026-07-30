import { describe, expect, it } from 'vitest';
import {
  buildEvent,
  deriveEvent,
  deduplicationKey,
  eventEnvelopeSchema,
  eventNameSchema,
  orderingKey,
  type EventActor,
} from './envelope';
import {
  assertValidPattern,
  matchesAny,
  matchesPattern,
  patternSpecificity,
  rankMatching,
} from './pattern';
import {
  deserializeEvent,
  eventFingerprint,
  isSecretFieldName,
  MAX_EVENT_BYTES,
  redactEnvelope,
  redactPayload,
  serializeEvent,
} from './serialization';

const actor: EventActor = { id: 'usr_1', type: 'user', roles: ['maker'] };

/**
 * Asserts on the *detail* of a validation error, not its summary.
 *
 * `toThrow(/…/)` only sees `error.message`, which for an `ApiError` is the one-line summary. The
 * useful text — which field, and what to do about it — is in the details, so that is what these
 * tests read.
 */
function detailsOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const details = (error as { details?: Array<{ message: string }> }).details ?? [];
    return [(error as Error).message, ...details.map((entry) => entry.message)].join(' | ');
  }
  throw new Error('Expected the call to throw, and it did not.');
}

// Module-scoped, so two calls to `make()` produce two different event ids — which is the point
// of the test that a business-derived idempotency key survives distinct publications.
let idCounter = 0;

function make(overrides: Partial<Parameters<typeof buildEvent>[0]> = {}) {
  return buildEvent(
    {
      name: 'identity.user.created',
      payload: { userId: 'usr_1' },
      organizationId: 'org_1',
      actor,
      source: 'test-app',
      ...overrides,
    },
    {
      newId: () => `evt_${++idCounter}`,
      now: () => new Date('2026-07-01T10:00:00Z'),
    },
  );
}

describe('event names', () => {
  it.each([
    'user.created',
    'workflow.instance.state_changed',
    'integration.webhook.delivery_failed',
  ])('accepts %s', (name) => {
    expect(eventNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ['User.Created', 'uppercase'],
    ['user', 'no domain separator'],
    ['user..created', 'empty segment'],
    ['user.created.', 'trailing dot'],
    ['1user.created', 'leading digit'],
    ['user create', 'a space'],
  ])('rejects %s (%s)', (name) => {
    expect(eventNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('buildEvent', () => {
  it('defaults the idempotency key to the event id, so redelivery deduplicates', () => {
    const event = make();
    expect(event.idempotencyKey).toBe(event.id);
  });

  it('keeps a business-derived idempotency key, so two publications of one fact deduplicate', () => {
    const first = make({ idempotencyKey: 'user-created:usr_1' });
    const second = make({ idempotencyKey: 'user-created:usr_1' });

    expect(first.id).not.toBe(second.id);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  it('generates a correlation id rather than leaving the chain broken', () => {
    const event = make();
    expect(event.metadata.correlationId).toBe(event.id);
  });

  it('produces an envelope the schema accepts', () => {
    expect(eventEnvelopeSchema.safeParse(make()).success).toBe(true);
  });

  it('refuses an unknown envelope field', () => {
    expect(eventEnvelopeSchema.safeParse({ ...make(), tenantId: 'org_2' }).success).toBe(false);
  });
});

describe('deriveEvent', () => {
  it('keeps the correlation and points causation at the parent', () => {
    const parent = make({ correlationId: 'corr_root', requestId: 'req_1', traceId: 'trc_1' });
    const child = deriveEvent(
      parent,
      {
        name: 'identity.user.role_granted',
        payload: {},
        organizationId: 'org_1',
        actor,
        source: 'test-app',
      },
      { newId: () => 'evt_child' },
    );

    expect(child.metadata.correlationId).toBe('corr_root');
    expect(child.metadata.causationId).toBe(parent.id);
    expect(child.metadata.requestId).toBe('req_1');
    expect(child.metadata.traceId).toBe('trc_1');
  });

  it('survives a chain, so the whole tree shares one correlation', () => {
    const root = make({ correlationId: 'corr_root' });
    const a = deriveEvent(
      root,
      { name: 'a.b', payload: {}, organizationId: 'org_1', actor, source: 's' },
      { newId: () => 'evt_a' },
    );
    const b = deriveEvent(
      a,
      { name: 'a.c', payload: {}, organizationId: 'org_1', actor, source: 's' },
      { newId: () => 'evt_b' },
    );

    expect(b.metadata.correlationId).toBe('corr_root');
    expect(b.metadata.causationId).toBe('evt_a');
  });
});

describe('orderingKey', () => {
  it('is null without an aggregate, so unordered events do not serialise', () => {
    expect(orderingKey(make())).toBeNull();
  });

  it('separates tenants, so one tenant cannot serialise against another', () => {
    const a = make({ organizationId: 'org_a', aggregate: { type: 'Merchant', id: 'm_1' } });
    const b = make({ organizationId: 'org_b', aggregate: { type: 'Merchant', id: 'm_1' } });

    expect(orderingKey(a)).not.toBe(orderingKey(b));
  });

  it('matches for two events about the same aggregate', () => {
    const a = make({ aggregate: { type: 'Merchant', id: 'm_1' }, name: 'a.created' });
    const b = make({ aggregate: { type: 'Merchant', id: 'm_1' }, name: 'a.updated' });

    expect(orderingKey(a)).toBe(orderingKey(b));
  });
});

describe('deduplicationKey', () => {
  it('is scoped per subscriber, so each gets its own chance at the event', () => {
    const event = make();
    expect(deduplicationKey(event, 'sub_a')).not.toBe(deduplicationKey(event, 'sub_b'));
  });
});

describe('patterns', () => {
  it.each([
    ['workflow.task.assigned', 'workflow.task.assigned', true],
    ['workflow.task.assigned', 'workflow.*.assigned', true],
    ['workflow.task.assigned', 'workflow.**', true],
    ['workflow.task.assigned', '*', true],
    ['workflow.task.assigned', 'workflow.task', false],
    ['workflow.task', 'workflow.task.assigned', false],
    ['workflow.task.assigned', 'identity.**', false],
    ['workflow.task.assigned', 'workflow.*', false],
  ])('%s vs %s → %s', (name, pattern, expected) => {
    expect(matchesPattern(name, pattern)).toBe(expected);
  });

  it('does not let ** match zero segments', () => {
    // A subscriber to `workflow.**` is asking about children, not about `workflow` itself.
    expect(matchesPattern('workflow', 'workflow.**')).toBe(false);
  });

  it('does not silently widen a prefix subscription', () => {
    // The bug this guards: subscribing to `workflow.task` and receiving
    // `workflow.task.comment.added` without asking.
    expect(matchesPattern('workflow.task.comment.added', 'workflow.task')).toBe(false);
  });

  it('matches any of several patterns', () => {
    expect(matchesAny('document.uploaded', ['identity.**', 'document.*'])).toBe(true);
    expect(matchesAny('document.uploaded', ['identity.**', 'workflow.*'])).toBe(false);
  });

  it('ranks an exact name above a wildcard above a catch-all', () => {
    const ranked = rankMatching('workflow.task.assigned', [
      '**',
      'workflow.*.assigned',
      'workflow.task.assigned',
      'workflow.**',
    ]);

    expect(ranked[0]).toBe('workflow.task.assigned');
    expect(ranked.at(-1)).toBe('**');
    expect(patternSpecificity('workflow.task.assigned')).toBeGreaterThan(
      patternSpecificity('workflow.*.assigned'),
    );
  });

  it('rejects ** anywhere but the end, because the split would be ambiguous', () => {
    expect(detailsOf(() => assertValidPattern('a.**.c'))).toMatch(/final segment/);
    expect(() => assertValidPattern('a.**')).not.toThrow();
  });

  it.each(['A.b', 'a b', 'a.(b|c)', 'a.b?', ''])('rejects the pattern %j', (pattern) => {
    expect(() => assertValidPattern(pattern)).toThrow();
  });

  it('costs the same for a pathological pattern as for a plain one', () => {
    // The reason matching walks segments instead of compiling a regex: this input is the
    // classic catastrophic-backtracking shape, and here it is just a long list of segments.
    const pattern = `${'a.'.repeat(60)}**`;
    assertValidPattern(pattern);

    const started = process.hrtime.bigint();
    matchesPattern(`${'a.'.repeat(60)}b`, pattern);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(10);
  });
});

describe('redaction', () => {
  it.each(['password', 'apiKey', 'accessToken', 'clientSecret', 'Authorization', 'cardNumber'])(
    'treats %s as secret',
    (field) => {
      expect(isSecretFieldName(field)).toBe(true);
    },
  );

  it.each(['tokenId', 'apiKeyId', 'signatureVersion', 'correlationId', 'idempotencyKey'])(
    'keeps the identifier %s, which a consumer needs',
    (field) => {
      expect(isSecretFieldName(field)).toBe(false);
    },
  );

  it('redacts nested secrets and keeps everything else', () => {
    const redacted = redactPayload({
      userId: 'usr_1',
      connection: { password: 'hunter2', tokenId: 'tok_1', host: 'db.internal' },
    }) as Record<string, Record<string, string>>;

    expect(redacted.userId).toBe('usr_1');
    expect(redacted.connection?.password).toBe('[REDACTED]');
    expect(redacted.connection?.host).toBe('db.internal');
    // Kept, because a consumer correlating on a token id is not holding a token.
    expect(redacted.connection?.tokenId).toBe('tok_1');
  });

  it('redacts a whole secret-named object rather than walking into it', () => {
    // `credentials` matches the denylist itself, so nothing inside it needs to. That is the
    // intended behaviour: a container named for what it holds is the clearest signal there is.
    const redacted = redactPayload({ credentials: { username: 'svc', password: 'x' } }) as Record<
      string,
      unknown
    >;

    expect(redacted.credentials).toBe('[REDACTED]');
  });

  it('survives a cycle rather than overflowing the stack', () => {
    const payload: Record<string, unknown> = { name: 'a' };
    payload.self = payload;

    expect(() => redactPayload(payload)).not.toThrow();
    expect((redactPayload(payload) as Record<string, string>).self).toBe('[CIRCULAR]');
  });

  it('truncates beyond the depth limit, so a deep payload cannot exhaust the stack', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };

    expect(() => redactPayload(deep)).not.toThrow();
  });

  it('redacts inside the envelope, including its attributes', () => {
    const event = make({ payload: { token: 'secret-value' }, attributes: { apiKey: 'k' } });
    const redacted = redactEnvelope(event);

    expect((redacted.payload as Record<string, string>).token).toBe('[REDACTED]');
    expect(redacted.metadata.attributes.apiKey).toBe('[REDACTED]');
    expect(redacted.id).toBe(event.id);
  });
});

describe('serialization', () => {
  it('round-trips, with occurredAt still a Date', () => {
    const event = make();
    const parsed = deserializeEvent(serializeEvent(event));

    expect(parsed.occurredAt).toBeInstanceOf(Date);
    expect(parsed.occurredAt.getTime()).toBe(event.occurredAt.getTime());
    expect(parsed.id).toBe(event.id);
  });

  it('refuses an oversized event with advice rather than a size number alone', () => {
    const event = make({ payload: { blob: 'x'.repeat(MAX_EVENT_BYTES + 1) } });

    expect(detailsOf(() => serializeEvent(event))).toMatch(/document module/);
  });

  it('rejects malformed JSON', () => {
    expect(detailsOf(() => deserializeEvent('{ not json'))).toMatch(/could not be parsed/);
  });

  it('rejects a structurally invalid envelope', () => {
    expect(detailsOf(() => deserializeEvent(JSON.stringify({ id: 'evt_1' })))).toMatch(/not valid/);
  });

  it('rejects an envelope with an extra field, so a producer cannot smuggle one through', () => {
    const event = { ...make(), injected: 'value' };
    expect(() => deserializeEvent(JSON.stringify(event))).toThrow();
  });
});

describe('eventFingerprint', () => {
  it('ignores id and timestamp, so two publications of one fact match', async () => {
    const first = make({ idempotencyKey: 'fact_1', occurredAt: new Date('2026-01-01') });
    const second = make({ idempotencyKey: 'fact_1', occurredAt: new Date('2026-06-01') });

    expect(await eventFingerprint(first)).toBe(await eventFingerprint(second));
  });

  it('is stable across key order, so a JSON round-trip does not change it', async () => {
    const a = make({ idempotencyKey: 'fact_1', payload: { b: 2, a: 1 } });
    const b = make({ idempotencyKey: 'fact_1', payload: { a: 1, b: 2 } });

    expect(await eventFingerprint(a)).toBe(await eventFingerprint(b));
  });

  it('differs when the payload differs under the same key', async () => {
    const a = make({ idempotencyKey: 'fact_1', payload: { amount: 100 } });
    const b = make({ idempotencyKey: 'fact_1', payload: { amount: 200 } });

    expect(await eventFingerprint(a)).not.toBe(await eventFingerprint(b));
  });
});
