import { describe, expect, it } from 'vitest';
import {
  algNoneToken,
  assertNoLeakedValues,
  assertSecretFieldsRedacted,
  findLeakedValues,
  findUnredactedSecretFields,
  SECURITY_TEST_CATEGORIES,
  tamperedPayload,
} from './index';

/**
 * The security test harness — tested, because a harness nobody checks is a harness that passes.
 *
 * This is the package other packages use to prove they do not leak secrets. If
 * `findLeakedValues` misses something, every suite that relies on it reports clean while the leak
 * is still there — a false negative that propagates across the whole framework rather than
 * staying in one place.
 *
 * So the tests here are the inverse of the usual ones: they check the detector *finds* things,
 * and they check it does not quietly stop looking.
 */

describe('finding leaked values', () => {
  const secret = 'super-secret-token-value';

  it('finds a secret at the top level', () => {
    expect(findLeakedValues({ token: secret }, [secret])).toHaveLength(1);
  });

  it('finds a secret nested deep in an object', () => {
    // A leak is rarely at the top. It is three levels down in an error context nobody looked at.
    const subject = { a: { b: { c: { leaked: secret } } } };

    expect(findLeakedValues(subject, [secret])).toHaveLength(1);
  });

  it('finds a secret inside an array', () => {
    expect(findLeakedValues({ items: ['fine', secret] }, [secret])).toHaveLength(1);
  });

  it('finds a secret embedded in a longer string', () => {
    /*
     * The common shape: the value is not the whole field, it is inside a message. A detector that
     * only compared whole values would report clean.
     */
    const subject = { message: `request failed with ${secret} in the header` };

    expect(findLeakedValues(subject, [secret])).toHaveLength(1);
  });

  it('says where it found it', () => {
    // A finding with no path makes the caller search for it by hand.
    const findings = findLeakedValues({ outer: { inner: secret } }, [secret]);

    expect(findings[0]?.path).toContain('inner');
  });

  it('finds nothing when there is nothing', () => {
    expect(findLeakedValues({ token: 'redacted', count: 3 }, [secret])).toEqual([]);
  });

  it('ignores an empty or trivially short secret', () => {
    /*
     * A one-character secret matches almost every payload. Without this guard the harness reports
     * a leak on every test and gets switched off.
     */
    expect(findLeakedValues({ text: 'anything at all' }, ['', 'a'])).toEqual([]);
  });

  it('checks every secret it is given, not just the first', () => {
    const findings = findLeakedValues({ a: 'first-secret-value', b: 'second-secret-value' }, [
      'first-secret-value',
      'second-secret-value',
    ]);

    expect(findings).toHaveLength(2);
  });

  it('throws with the path when asserting', () => {
    expect(() => assertNoLeakedValues({ ctx: { key: secret } }, [secret], 'response')).toThrow(
      /ctx/,
    );
    expect(() => assertNoLeakedValues({ ctx: { key: 'safe' } }, [secret])).not.toThrow();
  });
});

describe('finding unredacted secret fields', () => {
  it('flags a field named like a secret carrying a real-looking value', () => {
    const fields = findUnredactedSecretFields({ password: 'hunter2hunter2hunter2' });

    expect(fields).toContain('password');
  });

  it('accepts a field that has been redacted', () => {
    /*
     * The point of the check is to catch what was *not* redacted. Flagging the redacted marker
     * would make the check fire on correct code.
     */
    for (const marker of ['[redacted]', '[REDACTED]', '***', '', '  ']) {
      expect({ marker, fields: findUnredactedSecretFields({ password: marker }) }).toEqual({
        marker,
        fields: [],
      });
    }
  });

  it('looks inside nested structures', () => {
    const fields = findUnredactedSecretFields({
      user: { credentials: { apiKey: 'sk-abcdefghijklmnop' } },
    });

    expect(fields.length).toBeGreaterThan(0);
  });

  it('throws when asserting on an unredacted field', () => {
    expect(() => assertSecretFieldsRedacted({ secret: 'a-real-looking-secret-value' })).toThrow();
    expect(() => assertSecretFieldsRedacted({ secret: '***' })).not.toThrow();
  });
});

describe('token fixtures', () => {
  it('builds an alg:none token, which every verifier must reject', () => {
    /*
     * The oldest JWT attack there is: strip the signature and set `alg` to `none`. A library that
     * honours it accepts any token. This fixture exists so every verifier in the framework has a
     * test proving it does not.
     */
    const token = algNoneToken({ sub: 'attacker' });
    const [header] = token.split('.');
    const decoded = JSON.parse(Buffer.from(header as string, 'base64url').toString());

    expect(decoded.alg).toBe('none');
    expect(token.split('.')).toHaveLength(3);
  });

  it('produces a token whose payload was changed without re-signing', () => {
    // The other half: a valid-looking token whose claims no longer match the signature.
    const original =
      `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.` +
      `${Buffer.from(JSON.stringify({ sub: 'user', role: 'viewer' })).toString('base64url')}.` +
      'originalsignature';

    const tampered = tamperedPayload(original, { role: 'admin' });
    const [, payload, signature] = tampered.split('.');
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString());

    expect(claims.role).toBe('admin');
    expect(claims.sub).toBe('user');
    // The signature is carried over unchanged — that is what makes it a tampered token.
    expect(signature).toBe('originalsignature');
  });
});

describe('the category list', () => {
  it('names the categories a security review walks through', () => {
    expect(SECURITY_TEST_CATEGORIES.length).toBeGreaterThan(3);
    expect(new Set(SECURITY_TEST_CATEGORIES).size).toBe(SECURITY_TEST_CATEGORIES.length);
  });
});
