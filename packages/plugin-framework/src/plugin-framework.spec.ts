import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import {
  assertCompatible,
  assertPermissionsAllowed,
  assertTrusted,
  dangerousPermissionsOf,
  describePermissions,
  digestOf,
  digestOfFiles,
  parsePluginManifest,
  PluginRegistry,
  verifyArtifact,
  type ArtifactSignature,
  type TrustedKey,
} from './index';

/**
 * The supply chain tests.
 *
 * Every one of these is an attack that works against the naive implementation: a modified
 * artefact with a matching hash, a signature from a key nobody trusts, an algorithm downgrade, a
 * renamed file inside an archive, a plugin asking for permissions nobody granted.
 */

/** `toThrow(/…/)` sees only the summary; the useful text is in the details. */
function detailsOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (error) {
    if (error instanceof ApiError) return (error.details ?? []).map((d) => d.message).join(' | ');
    return error instanceof Error ? error.message : String(error);
  }
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const TRUSTED: TrustedKey[] = [
  { keyId: 'trustos-release', owner: 'TrustOS Platform Team', algorithm: 'Ed25519', publicKeyPem },
];

function signContent(content: string): ArtifactSignature {
  const digest = digestOf(content);

  return {
    keyId: 'trustos-release',
    algorithm: 'Ed25519',
    digest,
    signature: sign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64'),
  };
}

const MANIFEST = {
  id: 'acme-reporter',
  name: 'Acme Reporter',
  description: 'Adds a reporting command.',
  version: '1.0.0',
  author: 'Acme Engineering',
  license: 'MIT',
  frameworkRange: '^0.5.0',
  extensionPoints: ['cli'],
  permissions: ['cli:register', 'registry:read'],
};

describe('integrity', () => {
  it('gives a different digest to a renamed file', () => {
    /*
     * Hashing concatenated contents alone gives the same digest to two different layouts — rename
     * a file and the archive verifies unchanged, which is how a malicious postinstall gets
     * swapped in for a README.
     */
    const a = digestOfFiles([
      { path: 'index.js', content: 'console.log(1)' },
      { path: 'README.md', content: 'hello' },
    ]);

    const b = digestOfFiles([
      { path: 'postinstall.js', content: 'console.log(1)' },
      { path: 'README.md', content: 'hello' },
    ]);

    expect(a).not.toBe(b);
  });

  it('is stable regardless of file order', () => {
    const a = digestOfFiles([
      { path: 'b.js', content: '2' },
      { path: 'a.js', content: '1' },
    ]);

    const b = digestOfFiles([
      { path: 'a.js', content: '1' },
      { path: 'b.js', content: '2' },
    ]);

    expect(a).toBe(b);
  });
});

describe('verification', () => {
  it('accepts a genuine artefact', () => {
    const content = 'the plugin bytes';

    expect(
      verifyArtifact({ content, signature: signContent(content), trustedKeys: TRUSTED }),
    ).toEqual({
      trusted: true,
      keyId: 'trustos-release',
      owner: 'TrustOS Platform Team',
    });
  });

  it('refuses an unsigned artefact rather than skipping the check', () => {
    /*
     * The single most common way signing gets defeated: a code path that treats "no signature"
     * as "nothing to check".
     */
    const outcome = verifyArtifact({ content: 'x', signature: null, trustedKeys: TRUSTED });

    expect(outcome).toMatchObject({ trusted: false, code: 'unsigned' });
  });

  it('refuses content modified after signing', () => {
    const signature = signContent('original');
    const outcome = verifyArtifact({ content: 'tampered', signature, trustedKeys: TRUSTED });

    expect(outcome).toMatchObject({ trusted: false, code: 'digest_mismatch' });
  });

  it('refuses a signature from a key nobody trusts', () => {
    const outcome = verifyArtifact({ content: 'x', signature: signContent('x'), trustedKeys: [] });

    expect(outcome).toMatchObject({ trusted: false, code: 'unknown_key' });
  });

  it('refuses a revoked key and an expired one', () => {
    const content = 'x';
    const signature = signContent(content);

    expect(
      verifyArtifact({
        content,
        signature,
        trustedKeys: [{ ...TRUSTED[0]!, revoked: true }],
      }),
    ).toMatchObject({ code: 'key_revoked' });

    expect(
      verifyArtifact({
        content,
        signature,
        trustedKeys: [{ ...TRUSTED[0]!, expiresAt: '2020-01-01' }],
        now: new Date('2026-01-01'),
      }),
    ).toMatchObject({ code: 'key_expired' });
  });

  it('refuses an algorithm downgrade', () => {
    /*
     * Present a signature claiming a weaker algorithm than the key was issued for and hope the
     * verifier honours the claim. The key decides, not the artefact.
     */
    const content = 'x';
    const signature = { ...signContent(content), algorithm: 'RSA-SHA256' as const };

    expect(verifyArtifact({ content, signature, trustedKeys: TRUSTED })).toMatchObject({
      code: 'algorithm_mismatch',
    });
  });

  it('treats a malformed key as a failure rather than an exception', () => {
    // An attacker who can make the verifier throw can make a caller that forgot a try/catch skip
    // the check entirely.
    const content = 'x';

    expect(
      verifyArtifact({
        content,
        signature: signContent(content),
        trustedKeys: [{ ...TRUSTED[0]!, publicKeyPem: 'not a key' }],
      }),
    ).toMatchObject({ trusted: false, code: 'bad_signature' });
  });
});

describe('assertTrusted', () => {
  it('lets --allow-unsigned through only for a missing signature', () => {
    const unsigned = verifyArtifact({ content: 'x', signature: null, trustedKeys: TRUSTED });

    expect(() => assertTrusted(unsigned, { artifact: 'p', allowUnsigned: true })).not.toThrow();
  });

  it('never lets --allow-unsigned through a bad signature', () => {
    /*
     * "Signed by someone you do not trust" is not "unsigned", and no flag should turn it into a
     * warning.
     */
    const bad = verifyArtifact({
      content: 'tampered',
      signature: signContent('original'),
      trustedKeys: TRUSTED,
    });

    expect(() => assertTrusted(bad, { artifact: 'p', allowUnsigned: true })).toThrow(
      /digest|modified/i,
    );
  });
});

describe('manifests', () => {
  it('accepts a well-formed manifest', () => {
    expect(parsePluginManifest(MANIFEST).id).toBe('acme-reporter');
  });

  it('refuses a documentation-only plugin asking for dangerous permissions', () => {
    // Either it does more than it says, or it needs less than it asks.
    expect(() =>
      parsePluginManifest({
        ...MANIFEST,
        extensionPoints: ['documentation'],
        permissions: ['process:spawn'],
      }),
    ).toThrow();
  });

  it('requires the registration permission that matches the extension point', () => {
    expect(() => parsePluginManifest({ ...MANIFEST, permissions: ['registry:read'] })).toThrow();
  });

  it('names the dangerous permissions', () => {
    const manifest = parsePluginManifest({
      ...MANIFEST,
      permissions: ['cli:register', 'network', 'database'],
    });

    expect(dangerousPermissionsOf(manifest)).toEqual(['network', 'database']);
  });

  it('describes permissions in terms of what a plugin can do to you', () => {
    // "Requests filesystem:write" is a string people scroll past.
    expect(describePermissions(parsePluginManifest(MANIFEST))).toEqual([
      'Add commands to the trustos CLI.',
      'Read the module and template catalogs.',
    ]);
  });

  it('refuses an unbounded framework range', () => {
    /*
     * `>=0.1.0` claims compatibility with versions that do not exist yet, which is a claim its
     * author cannot have tested.
     */
    const manifest = parsePluginManifest({ ...MANIFEST, frameworkRange: '>=0.1.0' });

    expect(detailsOf(() => assertCompatible(manifest, '0.5.0'))).toMatch(/do not exist yet/);
  });

  it('refuses a plugin built for another framework version', () => {
    expect(detailsOf(() => assertCompatible(parsePluginManifest(MANIFEST), '0.4.0'))).toMatch(
      /needs framework/,
    );
    expect(() => assertCompatible(parsePluginManifest(MANIFEST), '0.5.2')).not.toThrow();
  });
});

describe('permission policy', () => {
  const manifest = parsePluginManifest({
    ...MANIFEST,
    permissions: ['cli:register', 'network'],
  });

  it('needs explicit consent for a dangerous permission', () => {
    expect(() => assertPermissionsAllowed(manifest, {}, [])).toThrow(/explicit consent/);
    expect(() => assertPermissionsAllowed(manifest, {}, ['network'])).not.toThrow();
  });

  it('lets a deployment policy outrank consent', () => {
    // The person clicking is not the person who wrote the policy.
    expect(() => assertPermissionsAllowed(manifest, { denied: ['network'] }, ['network'])).toThrow(
      /this deployment forbids/,
    );
  });
});

describe('the plugin registry', () => {
  const content = 'plugin bytes';

  function install(registry: PluginRegistry, overrides: Record<string, unknown> = {}) {
    return registry.install({
      manifest: { ...MANIFEST, ...overrides },
      content,
      signature: signContent(content),
      trustedKeys: TRUSTED,
      frameworkVersion: '0.5.0',
    });
  }

  it('installs a signed, compatible plugin', () => {
    const registry = new PluginRegistry();
    const installed = install(registry);

    expect(installed.signedBy).toBe('trustos-release');
    expect(registry.list()).toHaveLength(1);
  });

  it('refuses a second install of the same id', () => {
    const registry = new PluginRegistry();
    install(registry);

    expect(() => install(registry)).toThrow(/already installed/);
  });

  it('records that a plugin was installed unsigned', () => {
    const registry = new PluginRegistry();

    const installed = registry.install({
      manifest: MANIFEST,
      content,
      signature: null,
      trustedKeys: TRUSTED,
      frameworkVersion: '0.5.0',
      allowUnsigned: true,
    });

    expect(installed.signedBy).toBeNull();
    expect(registry.unsigned().map((entry) => entry.manifest.id)).toEqual(['acme-reporter']);
  });

  it('refuses to remove a plugin something depends on', () => {
    // Cascading would be friendlier and wrong: taking three plugins with one is a change nobody
    // reviewed.
    const registry = new PluginRegistry();
    install(registry);
    install(registry, {
      id: 'acme-extra',
      dependencies: [{ pluginId: 'acme-reporter', versionRange: '^1.0.0' }],
    });

    expect(() => registry.remove('acme-reporter')).toThrow(/depend on it/);
    expect(() => registry.remove('acme-extra')).not.toThrow();
  });

  it('refuses a plugin whose dependency is missing or too old', () => {
    const registry = new PluginRegistry();
    install(registry);

    expect(
      detailsOf(() =>
        install(registry, {
          id: 'acme-b',
          dependencies: [{ pluginId: 'nope', versionRange: '^1.0.0' }],
        }),
      ),
    ).toMatch(/not installed/);

    expect(
      detailsOf(() =>
        install(registry, {
          id: 'acme-c',
          dependencies: [{ pluginId: 'acme-reporter', versionRange: '^2.0.0' }],
        }),
      ),
    ).toMatch(/1\.0\.0 is installed/);
  });

  it('leaves a disabled plugin out of the contributor list', () => {
    // One place decides, so a host that forgets cannot load it.
    const registry = new PluginRegistry();
    install(registry);

    expect(registry.contributorsTo('cli')).toHaveLength(1);
    registry.setEnabled('acme-reporter', false);
    expect(registry.contributorsTo('cli')).toHaveLength(0);
  });

  it('lists the privileged plugins', () => {
    const registry = new PluginRegistry();
    install(registry);
    registry.install({
      manifest: { ...MANIFEST, id: 'acme-danger', permissions: ['cli:register', 'database'] },
      content,
      signature: signContent(content),
      trustedKeys: TRUSTED,
      frameworkVersion: '0.5.0',
      grantedPermissions: ['database'],
    });

    expect(registry.privileged().map((entry) => entry.manifest.id)).toEqual(['acme-danger']);
  });

  it('refuses an incompatible plugin before verifying its signature', () => {
    const registry = new PluginRegistry();

    expect(() =>
      registry.install({
        manifest: MANIFEST,
        content,
        signature: null,
        trustedKeys: TRUSTED,
        frameworkVersion: '0.4.0',
      }),
    ).toThrow(ApiError);
  });
});
