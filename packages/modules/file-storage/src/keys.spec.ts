import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import {
  assertKeyBelongsTo,
  assertValidKey,
  isInside,
  isValidKey,
  organizationPrefix,
  resolveWithinRoot,
  tenantKey,
} from './keys';

/**
 * Containment.
 *
 * These are the tests to read before changing `keys.ts`. Each case is a way a
 * caller-supplied string has been used to read or write outside a storage root
 * in a real system.
 */

describe('isValidKey', () => {
  it('accepts ordinary keys', () => {
    for (const key of ['file.pdf', 'org/org_1/contract.pdf', 'a/b/c/d-e_f.2026.png']) {
      expect(isValidKey(key), key).toBe(true);
    }
  });

  it('rejects traversal in every form it takes', () => {
    for (const key of [
      '..',
      '../secret',
      'a/../../etc/passwd',
      'a/./b',
      './a',
      'a/..',
      '....//etc',
    ]) {
      expect(isValidKey(key), key).toBe(false);
    }
  });

  it('rejects absolute and drive-qualified paths', () => {
    for (const key of ['/etc/passwd', '\\\\server\\share', 'C:/Windows', 'C:file']) {
      expect(isValidKey(key), key).toBe(false);
    }
  });

  it('rejects null bytes and control characters', () => {
    // A null byte truncates the path in some syscall layers, so `a\0.png`
    // becomes `a` — a different object than the one that was validated.
    expect(isValidKey('a\u0000.png')).toBe(false);
    expect(isValidKey('a\u000a.png')).toBe(false);
    expect(isValidKey('a\u007f.png')).toBe(false);
  });

  it('rejects empty segments, spaces and backslashes', () => {
    for (const key of ['', 'a//b', 'a/', '/a', 'my file.pdf', 'a\\b']) {
      expect(isValidKey(key), key).toBe(false);
    }
  });

  it('rejects a leading dot, which is what stops both dotfiles and ..', () => {
    expect(isValidKey('.env')).toBe(false);
    expect(isValidKey('a/.git/config')).toBe(false);
  });

  it('rejects an over-long key', () => {
    expect(isValidKey(`${'a'.repeat(513)}`)).toBe(false);
  });

  it('reports a validation error rather than an internal one', () => {
    // The caller supplied it, so it is their mistake to fix.
    expect(() => assertValidKey('../x')).toThrowError(/not valid/);
  });
});

describe('isInside', () => {
  it('compares path segments, not string prefixes', () => {
    const root = resolve('/data/store');
    expect(isInside(root, join(root, 'a'))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    // The classic false positive: a sibling directory whose name extends the
    // root's name.
    expect(isInside(root, resolve('/data/store-evil/a'))).toBe(false);
    expect(isInside(root, resolve('/data'))).toBe(false);
  });
});

describe('resolveWithinRoot', () => {
  it('resolves a valid key under the root', () => {
    const path = resolveWithinRoot('/data/store', 'org/org_1/file.pdf');
    expect(path).toBe(resolve('/data/store/org/org_1/file.pdf'));
  });

  it('refuses a key that would escape, even before key validation is reached', () => {
    expect(() => resolveWithinRoot('/data/store', '../../etc/passwd')).toThrow();
  });
});

describe('organization namespaces', () => {
  it('prefixes every key with the organization', () => {
    expect(tenantKey('org_acme', 'contract.pdf')).toBe('org/org_acme/contract.pdf');
    expect(organizationPrefix('org_acme')).toBe('org/org_acme/');
  });

  it('does not let a caller choose the namespace it writes into', () => {
    // The prefix is added by `tenantKey`, so a caller-supplied "name" that looks
    // like another tenant's path lands inside its own namespace.
    expect(tenantKey('org_acme', 'org/org_rival/contract.pdf')).toBe(
      'org/org_acme/org/org_rival/contract.pdf',
    );
  });

  it('reports a key from another organization as not_found, not forbidden', () => {
    // A 403 would confirm the key exists somewhere else and turn the storage
    // API into an enumeration oracle.
    try {
      assertKeyBelongsTo('org_acme', 'org/org_rival/contract.pdf');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('not_found');
    }
  });

  it('accepts a key inside the organization namespace', () => {
    expect(assertKeyBelongsTo('org_acme', 'org/org_acme/a/b.pdf')).toBe('org/org_acme/a/b.pdf');
  });

  it('is not fooled by a namespace whose name extends another', () => {
    expect(() => assertKeyBelongsTo('org_acme', 'org/org_acme_evil/x.pdf')).toThrow();
  });
});
