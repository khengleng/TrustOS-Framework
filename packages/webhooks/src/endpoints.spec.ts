import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EventRegistry, type EventSchemaDefinition } from '@trustsystem/event-registry';
import { AUTO_DISABLE_THRESHOLD, DEFAULT_ROTATION_GRACE_MS, WebhookService } from './endpoints';
import { AesSecretCipher, PlaintextSecretCipher, secretHint } from './secrets';
import { createInMemoryWebhookStores } from './testing';
import { verifySignature, buildSignatureHeader } from './signature';

/**
 * The detail of a validation error, not its summary.
 *
 * `rejects.toThrow(/…/)` only sees `error.message`, which for an `ApiError` is the one-line
 * summary. The text worth asserting on — which field, and why — is in the details.
 */
async function detailsOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const details = (error as { details?: Array<{ message: string }> }).details ?? [];
    return [(error as Error).message, ...details.map((entry) => entry.message)].join(' | ');
  }
  throw new Error('Expected the call to reject, and it did not.');
}

const SCHEMAS: EventSchemaDefinition[] = [
  {
    name: 'test.thing.created',
    version: '1',
    description: 'A thing was created.',
    payload: z.object({}).passthrough(),
  },
  {
    name: 'test.thing.updated',
    version: '1',
    description: 'A thing was updated.',
    payload: z.object({}).passthrough(),
  },
];

let clock = new Date('2026-07-01T10:00:00Z');
let counter = 0;

function setup(
  overrides: { cipher?: ConstructorParameters<typeof WebhookService>[0]['cipher'] } = {},
) {
  const stores = createInMemoryWebhookStores(() => clock);
  const audit = { record: vi.fn() };

  const service = new WebhookService({
    endpoints: stores.endpoints,
    secrets: stores.secrets,
    subscriptions: stores.subscriptions,
    cipher: overrides.cipher ?? new PlaintextSecretCipher(),
    registry: new EventRegistry(SCHEMAS),
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { service, stores, audit };
}

async function anEndpoint(service: WebhookService, events = ['test.thing.created']) {
  return service.createEndpoint({
    organizationId: 'org_1',
    url: 'https://hooks.example.com/trustos',
    events,
    actorId: 'usr_1',
  });
}

beforeEach(() => {
  clock = new Date('2026-07-01T10:00:00Z');
  counter = 0;
});

describe('creating an endpoint', () => {
  it('returns the secret exactly once, at creation', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    expect(created.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(created.secretHint).toBe(created.secret.slice(-4));

    // There is no method to read it back. `listSecrets` returns metadata only, because a
    // "show secret" endpoint is indistinguishable from an exfiltration endpoint to anybody who
    // has stolen a session.
    const listed = await service.listSecrets(created.endpoint.id, 'org_1');
    expect(listed[0]).not.toHaveProperty('secret');
    expect(listed[0]?.hint).toBe(created.secretHint);
  });

  it('generates the secret rather than accepting one', async () => {
    const { service } = setup();
    const first = await anEndpoint(service);
    const second = await anEndpoint(service);

    // A caller-supplied secret has already been in a request body and a client log before it was
    // ever used. `CreateEndpointInput` has no field for one.
    expect(first.secret).not.toBe(second.secret);
  });

  it('creates one subscription per event pattern', async () => {
    const { service } = setup();
    const created = await anEndpoint(service, ['test.thing.created', 'test.thing.*']);

    expect(created.subscriptions).toHaveLength(2);
  });

  it('refuses an endpoint subscribed to nothing', async () => {
    const { service } = setup();

    await expect(
      service.createEndpoint({
        organizationId: 'org_1',
        url: 'https://hooks.example.com/x',
        events: [],
        actorId: 'usr_1',
      }),
    ).rejects.toThrow(/no event subscriptions/i);
  });

  it('refuses a subscription to an event nobody publishes, because the symptom is silence', async () => {
    const { service } = setup();

    await expect(anEndpoint(service, ['test.thing.create'])).rejects.toThrow(
      /events that do not exist/i,
    );
  });

  it('accepts a wildcard that matches nothing yet', async () => {
    const { service } = setup();

    await expect(anEndpoint(service, ['future.**'])).resolves.toBeDefined();
  });

  it('refuses a plain-HTTP URL, over which the signature is replayable', async () => {
    const { service } = setup();

    const message = await detailsOf(() =>
      service.createEndpoint({
        organizationId: 'org_1',
        url: 'http://hooks.example.com/x',
        events: ['test.thing.created'],
        actorId: 'usr_1',
      }),
    );

    expect(message).toMatch(/HTTPS/i);
  });

  it('allows http://localhost, for development', async () => {
    const { service } = setup();

    await expect(
      service.createEndpoint({
        organizationId: 'org_1',
        url: 'http://localhost:4000/hook',
        events: ['test.thing.created'],
        actorId: 'usr_1',
      }),
    ).resolves.toBeDefined();
  });

  it('records an audit entry with the URL and never the secret', async () => {
    const { service, audit } = setup();
    const created = await anEndpoint(service);

    const [entry] = audit.record.mock.calls[0] as [{ after: Record<string, unknown> }];
    expect(entry.after).toEqual({
      url: 'https://hooks.example.com/trustos',
      events: ['test.thing.created'],
    });
    expect(JSON.stringify(entry)).not.toContain(created.secret);
  });
});

describe('tenant isolation', () => {
  it('does not return another organization’s endpoint', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    await expect(service.getEndpoint(created.endpoint.id, 'org_2')).rejects.toThrow(/No webhook/);
  });

  it('does not list another organization’s endpoints', async () => {
    const { service } = setup();
    await anEndpoint(service);

    expect(await service.listEndpoints({ organizationId: 'org_2' })).toEqual({
      items: [],
      total: 0,
    });
  });

  it('does not rotate another organization’s secret', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    await expect(
      service.rotateSecret(created.endpoint.id, 'org_2', { actorId: 'usr_intruder' }),
    ).rejects.toThrow(/No webhook/);
  });
});

describe('secret rotation', () => {
  it('keeps the old secret signing during the grace period', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    const rotated = await service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' });

    const signing = await service.signingSecrets(created.endpoint.id, 'org_1');

    // Both, so a receiver that has updated and one that has not both verify. A rotation with no
    // overlap breaks every receiver at once, which in practice means nobody ever rotates.
    expect(signing).toHaveLength(2);
    expect(signing).toContain(created.secret);
    expect(signing).toContain(rotated.secret);
  });

  it('stops using the old secret once the grace period ends', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);
    const rotated = await service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' });

    clock = new Date(clock.getTime() + DEFAULT_ROTATION_GRACE_MS + 1000);

    const signing = await service.signingSecrets(created.endpoint.id, 'org_1');
    expect(signing).toEqual([rotated.secret]);
  });

  it('produces a header both receivers can verify mid-rotation', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);
    const rotated = await service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' });

    const secrets = await service.signingSecrets(created.endpoint.id, 'org_1');
    const body = '{"id":"evt_1"}';
    const header = buildSignatureHeader(secrets, 1_753_900_000, body);
    const now = () => 1_753_900_000_000;

    expect(verifySignature({ body, header, secrets: [created.secret], now }).valid).toBe(true);
    expect(verifySignature({ body, header, secrets: [rotated.secret], now }).valid).toBe(true);
  });

  it('refuses a second rotation while one is in flight', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);
    await service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' });

    // Three valid secrets would leave a receiver with no way to know which is current.
    await expect(
      service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' }),
    ).rejects.toThrow(/already in progress/);
  });

  it('allows a rotation again once the previous one has settled', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);
    await service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' });

    clock = new Date(clock.getTime() + DEFAULT_ROTATION_GRACE_MS + 1000);

    await expect(
      service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' }),
    ).resolves.toBeDefined();
  });

  it('honours a shorter grace period', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    const rotated = await service.rotateSecret(created.endpoint.id, 'org_1', {
      actorId: 'usr_1',
      graceMs: 60_000,
    });

    clock = new Date(clock.getTime() + 61_000);
    expect(await service.signingSecrets(created.endpoint.id, 'org_1')).toEqual([rotated.secret]);
  });

  it('audits hints rather than values', async () => {
    const { service, audit } = setup();
    const created = await anEndpoint(service);
    const rotated = await service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' });

    const rotationEntry = audit.record.mock.calls
      .map(([entry]) => entry as { action: string; after?: Record<string, unknown> })
      .find((entry) => entry.action === 'webhook.secret.rotated');

    expect(rotationEntry?.after?.newSecretHint).toBe(secretHint(rotated.secret));
    expect(JSON.stringify(rotationEntry)).not.toContain(rotated.secret);
    expect(JSON.stringify(rotationEntry)).not.toContain(created.secret);
  });
});

describe('revoking a secret', () => {
  it('refuses to revoke the only active secret', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);
    const [only] = await service.listSecrets(created.endpoint.id, 'org_1');

    // Revoking it would leave nothing to sign with and every delivery would fail.
    await expect(service.revokeSecret(only!.id, 'org_1', 'usr_1')).rejects.toThrow(
      /only active secret/,
    );
  });

  it('revokes an old secret immediately after a rotation', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);
    const rotated = await service.rotateSecret(created.endpoint.id, 'org_1', { actorId: 'usr_1' });

    const secrets = await service.listSecrets(created.endpoint.id, 'org_1');
    const old = secrets.find((secret) => secret.hint === created.secretHint);

    await service.revokeSecret(old!.id, 'org_1', 'usr_1');

    // No grace period: a leaked secret lets anybody forge deliveries, and a broken integration is
    // recoverable in a way that is not.
    expect(await service.signingSecrets(created.endpoint.id, 'org_1')).toEqual([rotated.secret]);
  });
});

describe('endpoint health', () => {
  it('disables an endpoint after sustained failure', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    for (let i = 0; i < AUTO_DISABLE_THRESHOLD; i += 1) {
      await service.recordOutcome(created.endpoint.id, 'org_1', {
        succeeded: false,
        reason: '502 Bad Gateway',
      });
    }

    const endpoint = await service.getEndpoint(created.endpoint.id, 'org_1');
    expect(endpoint.status).toBe('disabled');
    expect(endpoint.disabledReason).toMatch(/consecutive failures/);
  });

  it('resets the counter on any success, so a bad week is not a disabled endpoint', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    for (let i = 0; i < AUTO_DISABLE_THRESHOLD - 1; i += 1) {
      await service.recordOutcome(created.endpoint.id, 'org_1', { succeeded: false });
    }
    await service.recordOutcome(created.endpoint.id, 'org_1', { succeeded: true });
    await service.recordOutcome(created.endpoint.id, 'org_1', { succeeded: false });

    const endpoint = await service.getEndpoint(created.endpoint.id, 'org_1');
    expect(endpoint.status).toBe('active');
    expect(endpoint.consecutiveFailures).toBe(1);
  });

  it('disables at once on an explicit stop, without counting to a threshold', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    await service.recordOutcome(created.endpoint.id, 'org_1', {
      succeeded: false,
      reason: '410 Gone',
      disableImmediately: true,
    });

    const endpoint = await service.getEndpoint(created.endpoint.id, 'org_1');
    expect(endpoint.status).toBe('disabled');
    expect(endpoint.disabledReason).toMatch(/410 Gone/);
  });

  it('clears the failure counter when an operator re-enables it', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    for (let i = 0; i < AUTO_DISABLE_THRESHOLD; i += 1) {
      await service.recordOutcome(created.endpoint.id, 'org_1', { succeeded: false });
    }

    const reactivated = await service.setStatus(created.endpoint.id, 'org_1', 'active', 'usr_1');

    // Without this, the endpoint is one failure away from disabling itself again, with no
    // indication why.
    expect(reactivated.status).toBe('active');
    expect(reactivated.consecutiveFailures).toBe(0);
    expect(reactivated.disabledReason).toBeNull();
  });

  it('does nothing for an endpoint that no longer exists', async () => {
    const { service } = setup();

    await expect(
      service.recordOutcome('whep_missing', 'org_1', { succeeded: false }),
    ).resolves.toBeUndefined();
  });
});

describe('subscriptions', () => {
  it('refuses a duplicate pattern, which would send the event twice', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    await expect(
      service.addSubscription(created.endpoint.id, 'org_1', 'test.thing.created', 'usr_1'),
    ).rejects.toThrow(/already subscribed/);
  });

  it('adds and removes a pattern', async () => {
    const { service } = setup();
    const created = await anEndpoint(service);

    const added = await service.addSubscription(
      created.endpoint.id,
      'org_1',
      'test.thing.updated',
      'usr_1',
    );
    expect(await service.listSubscriptions(created.endpoint.id, 'org_1')).toHaveLength(2);

    await service.removeSubscription(added.id, created.endpoint.id, 'org_1', 'usr_1');
    expect(await service.listSubscriptions(created.endpoint.id, 'org_1')).toHaveLength(1);
  });
});

describe('encryption at rest', () => {
  it('stores ciphertext and returns the original on read', async () => {
    const cipher = new AesSecretCipher('a'.repeat(48));
    const { service, stores } = setup({ cipher });
    const created = await anEndpoint(service);

    const stored = [...stores.secrets.secrets.values()][0];
    expect(stored?.secret).not.toBe(created.secret);
    expect(stored?.secret).toMatch(/^v1\./);

    expect(await service.signingSecrets(created.endpoint.id, 'org_1')).toEqual([created.secret]);
  });

  it('uses a fresh IV every time, so two encryptions of one value differ', async () => {
    // IV reuse with GCM is catastrophic rather than merely weak: it leaks the XOR of the
    // plaintexts and allows forging the authentication tag.
    const cipher = new AesSecretCipher('a'.repeat(48));

    const first = await cipher.encrypt('the same value');
    const second = await cipher.encrypt('the same value');

    expect(first).not.toBe(second);
    expect(await cipher.decrypt(first)).toBe('the same value');
    expect(await cipher.decrypt(second)).toBe('the same value');
  });

  it('refuses a tampered ciphertext rather than returning garbage', async () => {
    const cipher = new AesSecretCipher('a'.repeat(48));
    const encrypted = await cipher.encrypt('whsec_original');

    const parts = encrypted.split('.');
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      Buffer.from('elsewhere').toString('base64'),
    ].join('.');

    // Authenticated encryption: a modified ciphertext fails rather than producing a plausible
    // wrong key that would then sign every delivery incorrectly.
    await expect(cipher.decrypt(tampered)).rejects.toThrow(/could not be decrypted/);
  });

  it('says both possible causes when decryption fails', async () => {
    const written = new AesSecretCipher('a'.repeat(48));
    const reading = new AesSecretCipher('b'.repeat(48));

    await expect(reading.decrypt(await written.encrypt('x'))).rejects.toThrow(
      /has changed since it was written, or the stored value has been modified/,
    );
  });

  it('refuses a short encryption key', () => {
    expect(() => new AesSecretCipher('too-short')).toThrow(/at least 32 characters/);
  });
});
