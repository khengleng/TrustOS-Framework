import { describe, expect, it } from 'vitest';
import { deepRedact, isSensitiveKey, tokenFingerprint } from './redaction';

describe('isSensitiveKey', () => {
  it('matches regardless of case and separator style', () => {
    for (const key of ['password', 'Password', 'refresh_token', 'REFRESH-TOKEN', 'refreshToken']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    expect(isSensitiveKey('email')).toBe(false);
    expect(isSensitiveKey('organizationId')).toBe(false);
  });
});

describe('deepRedact', () => {
  it('removes credentials at any depth', () => {
    const redacted = deepRedact({
      user: { email: 'ada@example.com', passwordHash: '$2b$12$abcdef' },
      session: { tokens: { accessToken: 'eyJhbGciOi', refreshToken: 'rt_live_secret' } },
      config: { DATABASE_URL: 'postgresql://user:pw@host/db' },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('$2b$12$abcdef');
    expect(serialized).not.toContain('eyJhbGciOi');
    expect(serialized).not.toContain('rt_live_secret');
    expect(serialized).not.toContain('postgresql://');
    // Non-sensitive fields survive, or the log is worthless.
    expect(serialized).toContain('ada@example.com');
  });

  it('redacts inside arrays', () => {
    const redacted = deepRedact([{ password: 'p1' }, { password: 'p2' }]);
    expect(JSON.stringify(redacted)).not.toContain('p1');
  });

  it('survives circular structures', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(() => JSON.stringify(deepRedact(node))).not.toThrow();
    expect(JSON.stringify(deepRedact(node))).toContain('[circular]');
  });

  it('bounds recursion depth', () => {
    let nested: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 30; i += 1) nested = { child: nested };
    expect(JSON.stringify(deepRedact(nested))).toContain('[truncated]');
  });

  it('serializes errors without losing the stack', () => {
    const result = deepRedact({ err: new Error('boom') }) as { err: { message: string } };
    expect(result.err.message).toBe('boom');
  });

  it('passes primitives through untouched', () => {
    expect(deepRedact('hello')).toBe('hello');
    expect(deepRedact(42)).toBe(42);
    expect(deepRedact(null)).toBe(null);
  });
});

describe('tokenFingerprint', () => {
  it('keeps enough to correlate and too little to replay', () => {
    const fingerprint = tokenFingerprint('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcd');
    expect(fingerprint).toBe('[redacted]:abcd');
    expect(tokenFingerprint(undefined)).toBe('[redacted]');
  });
});
