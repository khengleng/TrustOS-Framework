import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { loadConfig } from '@trustsystem/config';
import type { ApiError } from '@trustsystem/errors';
import { TokenService, hashRefreshToken } from './tokens';
import { hashPassword, needsRehash, verifyPassword, verifyPasswordAgainstDummy } from './password';
import { readBearerToken } from './nest/jwt-auth.guard';

const config = loadConfig({ source: { NODE_ENV: 'test' } });
const tokens = new TokenService(config);

const issue = () =>
  tokens.issueAccessToken({
    userId: 'user_1',
    email: 'ada@example.com',
    organizationId: 'org_acme',
    roles: ['administrator'],
    permissions: ['organization.read'],
    isSuperAdmin: false,
    tokenVersion: 3,
  });

describe('TokenService', () => {
  it('round-trips access token claims', () => {
    const claims = tokens.verifyAccessToken(issue().token);

    expect(claims.sub).toBe('user_1');
    expect(claims.org).toBe('org_acme');
    expect(claims.perms).toEqual(['organization.read']);
    expect(claims.tv).toBe(3);
    expect(claims.jti).toBeTruthy();
  });

  it('signs access and refresh tokens with different keys', () => {
    const access = issue().token;
    expect(() => tokens.verifyRefreshToken(access)).toThrowError(/Authentication is required/);
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ email: 'ada@example.com' }, 'not-the-real-secret', {
      subject: 'user_1',
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      expiresIn: 600,
    });
    expect(() => tokens.verifyAccessToken(forged)).toThrowError(/Authentication is required/);
  });

  it('rejects an unsigned "alg: none" token', () => {
    const unsigned = jwt.sign({ sub: 'user_1', email: 'a@b.c' }, '', { algorithm: 'none' });
    expect(() => tokens.verifyAccessToken(unsigned)).toThrowError(/Authentication is required/);
  });

  it('rejects a token issued for another audience or issuer', () => {
    const other = jwt.sign({ email: 'ada@example.com' }, config.auth.jwtSecret, {
      subject: 'user_1',
      issuer: 'someone-else',
      audience: config.auth.audience,
      expiresIn: 600,
    });
    expect(() => tokens.verifyAccessToken(other)).toThrowError(/Authentication is required/);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ email: 'ada@example.com' }, config.auth.jwtSecret, {
      subject: 'user_1',
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      expiresIn: -10,
    });
    expect(() => tokens.verifyAccessToken(expired)).toThrowError(/Authentication is required/);
  });

  it('keeps the failure reason out of the client message', () => {
    try {
      tokens.verifyAccessToken('garbage');
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.message).toBe('Authentication is required to perform this action.');
      expect(String(apiError.context?.reason)).toMatch(/^token_/);
    }
  });

  it('issues distinct jtis so tokens are individually identifiable', () => {
    expect(issue().jti).not.toBe(issue().jti);
  });
});

describe('hashRefreshToken', () => {
  it('is deterministic and does not embed the token', () => {
    const hash = hashRefreshToken('rt_secret_value');
    expect(hash).toBe(hashRefreshToken('rt_secret_value'));
    expect(hash).not.toContain('rt_secret_value');
    expect(hash).toHaveLength(64);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('CorrectHorse7Battery', 10);
    expect(await verifyPassword('CorrectHorse7Battery', hash)).toBe(true);
    expect(await verifyPassword('CorrectHorse7Batter', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const [a, b] = await Promise.all([
      hashPassword('CorrectHorse7Battery', 10),
      hashPassword('CorrectHorse7Battery', 10),
    ]);
    expect(a).not.toBe(b);
  });

  it('always fails against the dummy hash', async () => {
    expect(await verifyPasswordAgainstDummy('anything')).toBe(false);
  });

  it('detects hashes below the desired cost factor', async () => {
    const hash = await hashPassword('CorrectHorse7Battery', 10);
    expect(needsRehash(hash, 12)).toBe(true);
    expect(needsRehash(hash, 10)).toBe(false);
    expect(needsRehash('not-a-bcrypt-hash', 10)).toBe(true);
  });
});

describe('readBearerToken', () => {
  it('accepts a well-formed header and rejects everything else', () => {
    expect(readBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(readBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(readBearerToken('Basic dXNlcjpwdw==')).toBeNull();
    expect(readBearerToken('Bearer')).toBeNull();
    expect(readBearerToken(undefined)).toBeNull();
  });
});
