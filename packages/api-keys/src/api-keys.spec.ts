import { describe, expect, it } from 'vitest';
import type { ApiError } from '@trustos/errors';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustos/security-events';
import { securityPolicySchema } from '@trustos/security-policy';
import { assertNoLeakedValues } from '@trustos/security-testing';
import { addressAllowed, assertValidAllowlist } from './ip-allowlist';
import { generateApiKey, hashApiKey, parseApiKey, verifyApiKey } from './key';
import { assertValidScopes, scopeSatisfies, scopesSatisfyAll } from './scopes';
import { InMemoryApiKeyStore } from './in-memory-store';
import { ApiKeyService } from './service';

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const policy = securityPolicySchema.parse({ environment: 'test' });

function build(overrides: Record<string, unknown> = {}) {
  const store = new InMemoryApiKeyStore();
  const sink = new InMemorySecurityEventSink();
  const events = new SecurityEventEmitter({ sinks: [sink], application: 'test' });

  const service = new ApiKeyService({
    store,
    policy: policy.apiKeys,
    events,
    allowedScopes: ['payments:read', 'payments:write', 'merchants:read', 'merchants:write'],
    environment: 'test',
    ...overrides,
  });

  return { service, store, sink };
}

const resolveAccess = async () => ({ roles: ['operator'], permissions: ['merchant.read'] });

describe('key format and hashing', () => {
  it('generates a key with a recognisable, greppable prefix', () => {
    const generated = generateApiKey('live');

    // A fixed prefix is what lets a secret scanner find a key in a commit, a log or
    // a support ticket.
    expect(generated.key).toMatch(/^tos_live_[a-z2-9]{32}$/);
    expect(generated.keyPrefix).toBe(generated.key.slice(0, 11));
    expect(generated.environment).toBe('live');
  });

  it('marks the environment, so a test key cannot pass for a live one', () => {
    expect(generateApiKey('test').key.startsWith('tos_test_')).toBe(true);
    expect(generateApiKey('live').key.startsWith('tos_live_')).toBe(true);
  });

  it('produces a distinct key every time', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it('hashes deterministically and irreversibly', () => {
    const { key, keyHash } = generateApiKey();

    expect(hashApiKey(key)).toBe(keyHash);
    expect(keyHash).toHaveLength(64);
    // The hash must not contain the key, in whole or in part.
    expect(keyHash).not.toContain(key.slice(9));
  });

  it('verifies a correct key and refuses a near-miss', () => {
    const { key, keyHash } = generateApiKey();

    expect(verifyApiKey(key, keyHash)).toBe(true);

    /*
     * A near-miss must differ from the key. Appending a fixed character produced the *same* key
     * whenever the last one already matched it — roughly one run in thirty, which is frequent
     * enough to be seen and rare enough to be dismissed as "flaky CI".
     */
    const lastCharacter = key.slice(-1);
    const nearMiss = `${key.slice(0, -1)}${lastCharacter === 'z' ? 'y' : 'z'}`;

    expect(nearMiss).not.toBe(key);
    expect(verifyApiKey(nearMiss, keyHash)).toBe(false);
    expect(verifyApiKey(generateApiKey().key, keyHash)).toBe(false);
    expect(verifyApiKey(key, '')).toBe(false);
  });

  it('rejects a malformed key without a database round trip', () => {
    expect(parseApiKey('not-a-key')).toBe(null);
    expect(parseApiKey('tos_live_short')).toBe(null);
    // `l`, `o`, `0` and `1` are excluded from the alphabet, so a transcription error
    // is a parse failure rather than a different key.
    expect(parseApiKey(`tos_live_${'l'.repeat(32)}`)).toBe(null);
  });
});

describe('creation', () => {
  it('returns the plaintext once and stores only a hash and a prefix', async () => {
    const { service, store } = build();

    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger sync',
      scopes: ['payments:read'],
    });

    expect(created.key).toMatch(/^tos_test_/);
    // The metadata a caller receives must carry no hash.
    expect('keyHash' in created.metadata).toBe(false);

    const stored = store.records.get(created.metadata.id);
    expect(stored?.keyHash).toBe(hashApiKey(created.key));

    // And there is no code path that produces the plaintext again.
    const listed = await service.list(ACME);
    assertNoLeakedValues(listed, [created.key], 'the key list');
  });

  it('never writes the key into a security event', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger sync',
      scopes: ['payments:read'],
    });

    assertNoLeakedValues(sink.events, [created.key], 'the security event trail');
    // The prefix is fine: it identifies the credential without being usable.
    expect(sink.serialized()).toContain(created.metadata.keyPrefix);
  });

  it('applies an expiry by default, because a key with none is permanent', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger sync',
      scopes: ['payments:read'],
    });

    expect(created.metadata.expiresAt).toBeInstanceOf(Date);
  });

  it('refuses a lifetime beyond the policy maximum', async () => {
    const { service } = build();

    await expect(
      service.create({
        organizationId: ACME,
        name: 'Forever',
        scopes: ['payments:read'],
        lifetimeSeconds: policy.apiKeys.maxLifetimeSeconds + 1,
      }),
    ).rejects.toThrow(/exceeds the policy maximum/);
  });

  it('refuses a duplicate name, because a name is how a key is revoked', async () => {
    const { service } = build();
    await service.create({ organizationId: ACME, name: 'Ledger', scopes: ['payments:read'] });

    await expect(
      service.create({ organizationId: ACME, name: 'Ledger', scopes: ['payments:read'] }),
    ).rejects.toThrow(/already exists/);
  });

  it('enforces a per-organization ceiling', async () => {
    const { service } = build({ policy: { ...policy.apiKeys, maxKeysPerOrganization: 2 } });

    await service.create({ organizationId: ACME, name: 'One', scopes: ['payments:read'] });
    await service.create({ organizationId: ACME, name: 'Two', scopes: ['payments:read'] });

    // A ceiling bounds the blast radius of a leak.
    await expect(
      service.create({ organizationId: ACME, name: 'Three', scopes: ['payments:read'] }),
    ).rejects.toThrow(/is the limit/);
  });

  it('refuses a scope the application does not offer', async () => {
    const { service } = build();

    await expect(
      service.create({ organizationId: ACME, name: 'Wide', scopes: ['everything:write'] }),
    ).rejects.toThrow(/not valid/);
  });

  it('refuses a wildcard scope even though matching understands one', async () => {
    const { service } = build();

    await expect(
      service.create({ organizationId: ACME, name: 'Wildcard', scopes: ['*'] }),
    ).rejects.toThrow(/not valid/);
  });

  it('refuses a key with no scopes at all', async () => {
    const { service } = build();

    // A key with no scopes could do nothing, so asking for one is a mistake worth
    // naming. The detail carries the reason; the message stays the generic one.
    try {
      await service.create({ organizationId: ACME, name: 'Empty', scopes: [] });
      expect.unreachable('should have thrown');
    } catch (error) {
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details.some((detail) => detail.message.includes('At least one scope'))).toBe(true);
    }
  });
});

describe('verification', () => {
  it('authenticates a valid key as an api_key actor', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });

    const verified = await service.verify({
      key: created.key,
      ipAddress: '203.0.113.9',
      resolveAccess,
    });

    expect(verified.actor.actorType).toBe('api_key');
    // The key's id, not a person's. An audit record must not name whoever created it.
    expect(verified.actor.userId).toBe(created.metadata.id);
    expect(verified.actor.scopes).toEqual(['payments:read']);
    // A key never carries platform-wide power.
    expect(verified.actor.isSuperAdmin).toBe(false);
  });

  it('refuses a revoked key', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });

    await service.revoke(created.metadata.id, ACME, 'leaked');

    await expect(
      service.verify({ key: created.key, ipAddress: null, resolveAccess }),
    ).rejects.toThrow(/not valid/);
    expect(sink.byType('api_key.auth_failed').at(-1)?.reason).toBe('key_revoked');
  });

  it('refuses an expired key', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const { service, sink } = build({ now: () => now });

    const created = await service.create({
      organizationId: ACME,
      name: 'Short lived',
      scopes: ['payments:read'],
      lifetimeSeconds: 60,
    });

    now = new Date('2026-01-01T00:02:00.000Z');

    await expect(
      service.verify({ key: created.key, ipAddress: null, resolveAccess }),
    ).rejects.toThrow(/not valid/);
    expect(sink.byType('api_key.expired')).toHaveLength(1);
  });

  it('refuses a key used from an address outside its allowlist', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Fixed egress',
      scopes: ['payments:read'],
      ipAllowlist: ['203.0.113.0/24'],
    });

    await expect(
      service.verify({ key: created.key, ipAddress: '198.51.100.7', resolveAccess }),
    ).rejects.toThrow(/not valid/);
    expect(sink.byType('api_key.ip_denied')).toHaveLength(1);

    // And accepts one inside it.
    await expect(
      service.verify({ key: created.key, ipAddress: '203.0.113.9', resolveAccess }),
    ).resolves.toBeTruthy();
  });

  it('gives the same error whatever the reason', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });
    await service.revoke(created.metadata.id, ACME, 'leaked');

    const errors: ApiError[] = [];
    for (const key of ['not-a-key', `tos_test_${'a'.repeat(32)}`, created.key]) {
      await service.verify({ key, ipAddress: null, resolveAccess }).catch((error) => {
        errors.push(error as ApiError);
      });
    }

    // Anything more specific tells a holder of a stolen key which problem to fix.
    expect(errors).toHaveLength(3);
    expect(new Set(errors.map((error) => error.message)).size).toBe(1);
    expect(new Set(errors.map((error) => error.code))).toEqual(new Set(['unauthorized']));
  });

  it('records the use, so a leak investigation has a timestamp and an address', async () => {
    const { service, store } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });

    await service.verify({ key: created.key, ipAddress: '203.0.113.9', resolveAccess });

    const record = store.records.get(created.metadata.id);
    expect(record?.usageCount).toBe(1);
    expect(record?.lastUsedIp).toBe('203.0.113.9');

    const usage = await service.usage(created.metadata.id, ACME);
    expect(usage.usageCount).toBe(1);
  });

  it('refuses a test key in a production deployment', async () => {
    const store = new InMemoryApiKeyStore();
    const development = build({ store }).service;
    const production = new ApiKeyService({
      store,
      policy: policy.apiKeys,
      environment: 'production',
    });

    const created = await development.create({
      organizationId: ACME,
      name: 'Dev key',
      scopes: ['payments:read'],
      environment: 'test',
    });

    // A `tos_test_` key reaching production is either a misconfigured client or a
    // developer key that escaped, and both are worth failing loudly.
    await expect(
      production.verify({ key: created.key, ipAddress: null, resolveAccess }),
    ).rejects.toThrow();

    // The same key still works where it belongs.
    await expect(
      development.verify({ key: created.key, ipAddress: null, resolveAccess }),
    ).resolves.toBeTruthy();
  });
});

describe('cross-organization isolation', () => {
  it('does not return another organization key by id', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: RIVAL,
      name: 'Rival key',
      scopes: ['payments:read'],
    });

    await expect(service.find(created.metadata.id, ACME)).rejects.toThrow();
  });

  it('does not let another organization revoke or rotate a key', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: RIVAL,
      name: 'Rival key',
      scopes: ['payments:read'],
    });

    await expect(service.revoke(created.metadata.id, ACME, 'malice')).rejects.toThrow();
    await expect(service.rotate(created.metadata.id, ACME)).rejects.toThrow();
  });

  it('lists only the calling organization keys', async () => {
    const { service } = build();
    await service.create({ organizationId: ACME, name: 'Ours', scopes: ['payments:read'] });
    await service.create({ organizationId: RIVAL, name: 'Theirs', scopes: ['payments:read'] });

    expect((await service.list(ACME)).map((key) => key.name)).toEqual(['Ours']);
  });
});

describe('revocation and rotation', () => {
  it('revokes idempotently, because it is used during an incident', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });

    await service.revoke(created.metadata.id, ACME, 'leaked');
    await service.revoke(created.metadata.id, ACME, 'leaked again');

    // The second click must not look like a failure.
    expect(sink.byType('api_key.revoked')).toHaveLength(1);
  });

  it('rotates by issuing a new key and letting the old one expire after a grace period', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { service, store } = build({ now: () => now });

    const original = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:write'],
      ipAllowlist: ['203.0.113.0/24'],
    });

    const rotated = await service.rotate(original.metadata.id, ACME);

    expect(rotated.key).not.toBe(original.key);
    expect(rotated.metadata.rotatedFromId).toBe(original.metadata.id);
    // The scopes and the allowlist carry over: a rotation must not quietly widen or
    // narrow what a credential can do.
    expect(rotated.metadata.scopes).toEqual(['payments:write']);
    expect(rotated.metadata.ipAllowlist).toEqual(['203.0.113.0/24']);

    // The old key still works, so a client can be redeployed without an outage.
    const old = store.records.get(original.metadata.id);
    expect(old?.revokedAt).toBe(null);
    expect(old?.expiresAt?.getTime()).toBe(
      now.getTime() + policy.apiKeys.rotationGraceSeconds * 1000,
    );

    await expect(
      service.verify({ key: original.key, ipAddress: '203.0.113.9', resolveAccess }),
    ).resolves.toBeTruthy();
  });

  it('refuses to rotate a revoked key', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });
    await service.revoke(created.metadata.id, ACME, 'leaked');

    await expect(service.rotate(created.metadata.id, ACME)).rejects.toThrow(/revoked/);
  });
});

describe('scopes', () => {
  it('treats write as covering read, and not the reverse', () => {
    expect(scopeSatisfies(['payments:write'], 'payments:read')).toBe(true);
    expect(scopeSatisfies(['payments:read'], 'payments:write')).toBe(false);
  });

  it('requires every scope when several are needed', () => {
    expect(scopesSatisfyAll(['payments:read'], ['payments:read', 'merchants:read'])).toBe(false);
    expect(
      scopesSatisfyAll(['payments:read', 'merchants:write'], ['payments:read', 'merchants:read']),
    ).toBe(true);
  });

  it('normalises and de-duplicates a requested list', () => {
    expect(assertValidScopes(['merchants:read', 'merchants:read', 'payments:read'])).toEqual([
      'merchants:read',
      'payments:read',
    ]);
  });
});

describe('IP allowlists', () => {
  it('permits everything when empty, which is the default', () => {
    expect(addressAllowed('203.0.113.9', [])).toBe(true);
    expect(addressAllowed(null, [])).toBe(true);
  });

  it('fails closed when the address is unknown and a rule exists', () => {
    // A rule that cannot be enforced must not pass. This is the case where the
    // deployment cannot determine the client address at all.
    expect(addressAllowed(null, ['203.0.113.0/24'])).toBe(false);
  });

  it('matches an IPv4 range on bytes, not on strings', () => {
    expect(addressAllowed('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(addressAllowed('203.0.114.9', ['203.0.113.0/24'])).toBe(false);
    // A prefix that is not a byte boundary.
    expect(addressAllowed('203.0.113.130', ['203.0.113.128/25'])).toBe(true);
    expect(addressAllowed('203.0.113.127', ['203.0.113.128/25'])).toBe(false);
  });

  it('matches a single address without a prefix', () => {
    expect(addressAllowed('203.0.113.9', ['203.0.113.9'])).toBe(true);
    expect(addressAllowed('203.0.113.10', ['203.0.113.9'])).toBe(false);
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    // What a deployment behind a dual-stack proxy actually sees.
    expect(addressAllowed('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true);
  });

  it('matches IPv6, including the compressed form', () => {
    expect(addressAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(addressAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(addressAllowed('::1', ['::1'])).toBe(true);
  });

  it('never matches across address families', () => {
    expect(addressAllowed('203.0.113.9', ['2001:db8::/32'])).toBe(false);
    expect(addressAllowed('2001:db8::1', ['203.0.113.0/24'])).toBe(false);
  });

  it('rejects a malformed entry at creation, so a typo is not a silent lockout', () => {
    expect(() => assertValidAllowlist(['203.0.113.0/33'])).toThrowError(/not valid/);
    expect(() => assertValidAllowlist(['203.0.113.999'])).toThrowError(/not valid/);
    expect(() => assertValidAllowlist(['not-an-address'])).toThrowError(/not valid/);
  });

  it('accepts a valid mixed list', () => {
    expect(assertValidAllowlist(['203.0.113.0/24', '2001:db8::/32', '198.51.100.7'])).toEqual([
      '198.51.100.7',
      '2001:db8::/32',
      '203.0.113.0/24',
    ]);
  });
});
