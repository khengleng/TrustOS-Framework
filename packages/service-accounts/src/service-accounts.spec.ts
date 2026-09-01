import { describe, expect, it } from 'vitest';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustsystem/security-events';
import { securityPolicySchema } from '@trustsystem/security-policy';
import { assertNoLeakedValues } from '@trustsystem/security-testing';
import { InMemoryServiceAccountStore } from './in-memory-store';
import {
  ServiceAccountService,
  generateServiceCredential,
  hashCredential,
  verifyCredential,
} from './service';

const policy = securityPolicySchema.parse({ environment: 'test' });
const ACME = 'org_acme';

function build(overrides: Record<string, unknown> = {}) {
  const store = new InMemoryServiceAccountStore();
  const sink = new InMemorySecurityEventSink();

  const service = new ServiceAccountService({
    store,
    policy: policy.apiKeys,
    events: new SecurityEventEmitter({ sinks: [sink], application: 'test' }),
    allowedScopes: ['payments:read', 'payments:write', 'reports:read'],
    ...overrides,
  });

  return { service, store, sink };
}

const resolveAccess = async () => ({ permissions: ['payment.read'] });

describe('credentials', () => {
  it('generates a distinct, prefixed credential', () => {
    const generated = generateServiceCredential();

    // A distinct scheme from an API key, so the two cannot be confused in a log or a
    // configuration file.
    expect(generated.credential).toMatch(/^tos_sa_[a-z2-9]{40}$/);
    expect(generated.prefix).toBe(generated.credential.slice(0, 13));
    expect(generateServiceCredential().credential).not.toBe(generated.credential);
  });

  it('hashes irreversibly and verifies in constant time', () => {
    const { credential, hash } = generateServiceCredential();

    expect(hashCredential(credential)).toBe(hash);
    expect(verifyCredential(credential, hash)).toBe(true);
    expect(verifyCredential(`${credential}x`, hash)).toBe(false);
    expect(verifyCredential(credential, '')).toBe(false);
  });
});

describe('creating an account', () => {
  it('returns a local credential once and stores only a hash', async () => {
    const { service, store } = build();

    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger sync',
      scopes: ['payments:read'],
      issueCredential: true,
    });

    expect(created.credential).toMatch(/^tos_sa_/);
    expect('credentialHash' in created.metadata).toBe(false);

    const stored = await store.findById(created.metadata.id);
    expect(stored?.credentialHash).toBe(hashCredential(created.credential as string));

    // No code path produces the plaintext again.
    assertNoLeakedValues(await service.list(ACME), [created.credential as string], 'the list');
  });

  it('never writes the credential into a security event', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger sync',
      scopes: ['payments:read'],
      issueCredential: true,
    });

    assertNoLeakedValues(sink.events, [created.credential as string], 'the event trail');
    expect(sink.serialized()).toContain(created.metadata.credentialPrefix as string);
  });

  it('issues no credential for an OIDC-backed account, because the provider owns it', async () => {
    const { service } = build();

    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger sync',
      scopes: ['payments:read'],
      oidcClientId: 'ledger-sync',
    });

    // The production recommendation: the framework holds no secret at all.
    expect(created.credential).toBeUndefined();
    expect(created.metadata.oidcClientId).toBe('ledger-sync');
  });

  it('refuses an account with both a provider client and a local credential', async () => {
    const { service } = build();

    // Two credentials for one identity means two things to rotate and two ways in,
    // and nobody keeps both inventories.
    await expect(
      service.create({
        organizationId: ACME,
        name: 'Both',
        scopes: ['payments:read'],
        oidcClientId: 'ledger-sync',
        issueCredential: true,
      }),
    ).rejects.toThrow(/one credential type/);
  });

  it('refuses a duplicate name and an unknown scope', async () => {
    const { service } = build();
    await service.create({ organizationId: ACME, name: 'Ledger', scopes: ['payments:read'] });

    await expect(
      service.create({ organizationId: ACME, name: 'Ledger', scopes: ['payments:read'] }),
    ).rejects.toThrow(/already exists/);

    await expect(
      service.create({ organizationId: ACME, name: 'Wide', scopes: ['everything:write'] }),
    ).rejects.toThrow(/not valid/);
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
});

describe('authenticating', () => {
  it('produces a service_account actor that is never platform staff', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
      roles: ['operator'],
      issueCredential: true,
    });

    const verified = await service.verifyCredential({
      credential: created.credential as string,
      ipAddress: '203.0.113.9',
      resolveAccess,
    });

    expect(verified.actor.actorType).toBe('service_account');
    // The account's own id. An audit record must name the machine, not whoever
    // created it.
    expect(verified.actor.userId).toBe(created.metadata.id);
    expect(verified.actor.scopes).toEqual(['payments:read']);
    // Platform-wide power belongs to somebody who can be asked why they used it.
    expect(verified.actor.isSuperAdmin).toBe(false);
  });

  it('records the use, so an unused integration is visible', async () => {
    const { service, store } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
      issueCredential: true,
    });

    await service.verifyCredential({
      credential: created.credential as string,
      ipAddress: '203.0.113.9',
      resolveAccess,
    });

    const stored = await store.findById(created.metadata.id);
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);
    expect(stored?.lastUsedIp).toBe('203.0.113.9');
  });

  it('refuses a disabled account', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
      issueCredential: true,
    });

    await service.disable(created.metadata.id, 'decommissioned');

    await expect(
      service.verifyCredential({
        credential: created.credential as string,
        ipAddress: null,
        resolveAccess,
      }),
    ).rejects.toThrow(/not valid/);

    expect(sink.byType('api_key.auth_failed').at(-1)?.reason).toBe('account_not_active');
  });

  it('refuses an expired account', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const { service } = build({ now: () => now });

    const created = await service.create({
      organizationId: ACME,
      name: 'Short lived',
      scopes: ['payments:read'],
      issueCredential: true,
      lifetimeSeconds: 60,
    });

    now = new Date('2026-01-01T00:02:00.000Z');

    await expect(
      service.verifyCredential({
        credential: created.credential as string,
        ipAddress: null,
        resolveAccess,
      }),
    ).rejects.toThrow();
  });

  it('gives the same error for every failure reason', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
      issueCredential: true,
    });
    await service.disable(created.metadata.id, 'decommissioned');

    const messages = new Set<string>();
    for (const credential of [
      'nonsense',
      `tos_sa_${'a'.repeat(40)}`,
      created.credential as string,
    ]) {
      await service
        .verifyCredential({ credential, ipAddress: null, resolveAccess })
        .catch((error: Error) => messages.add(error.message));
    }

    expect(messages.size).toBe(1);
  });

  it('resolves an OIDC client the provider already authenticated', async () => {
    const { service, sink } = build();
    await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
      oidcClientId: 'ledger-sync',
    });

    const verified = await service.resolveOidcClient({
      clientId: 'ledger-sync',
      ipAddress: null,
      resolveAccess,
    });

    expect(verified.actor.actorType).toBe('service_account');
    expect(verified.actor.provider).toBe('oidc-client-credentials');
    expect(sink.byType('service_account.used')).toHaveLength(1);
  });

  it('refuses an unknown OIDC client', async () => {
    const { service } = build();

    await expect(
      service.resolveOidcClient({ clientId: 'not-registered', ipAddress: null, resolveAccess }),
    ).rejects.toThrow();
  });
});

describe('lifecycle', () => {
  it('disables rather than deletes, so audit records stay resolvable', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });

    const disabled = await service.disable(created.metadata.id, 'decommissioned');

    expect(disabled.status).toBe('disabled');
    // Still resolvable: an account that acted on data must not become an orphaned id.
    expect(await service.find(created.metadata.id)).toBeTruthy();
    expect(sink.byType('service_account.disabled')).toHaveLength(1);
  });

  it('disables idempotently', async () => {
    const { service, sink } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
    });

    await service.disable(created.metadata.id, 'decommissioned');
    await service.disable(created.metadata.id, 'again');

    expect(sink.byType('service_account.disabled')).toHaveLength(1);
  });

  it('rotates a local credential with no grace period', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
      issueCredential: true,
    });

    const rotated = await service.rotateCredential(created.metadata.id);

    expect(rotated.credential).not.toBe(created.credential);
    // No overlap: a long-lived machine credential with a grace window is a second
    // valid secret for as long as the window lasts.
    await expect(
      service.verifyCredential({
        credential: created.credential as string,
        ipAddress: null,
        resolveAccess,
      }),
    ).rejects.toThrow();
    await expect(
      service.verifyCredential({ credential: rotated.credential, ipAddress: null, resolveAccess }),
    ).resolves.toBeTruthy();
  });

  it('refuses to rotate an OIDC-backed account locally', async () => {
    const { service } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:read'],
      oidcClientId: 'ledger-sync',
    });

    await expect(service.rotateCredential(created.metadata.id)).rejects.toThrow(
      /Rotate the client secret there/,
    );
  });

  it('checks scopes for an authenticated account', async () => {
    const { service, store } = build();
    const created = await service.create({
      organizationId: ACME,
      name: 'Ledger',
      scopes: ['payments:write'],
    });

    const record = await store.findById(created.metadata.id);
    expect(service.hasScopes(record!, ['payments:read'])).toBe(true);
    expect(service.hasScopes(record!, ['reports:read'])).toBe(false);
  });
});
