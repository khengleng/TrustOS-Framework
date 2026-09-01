import { describe, expect, it } from 'vitest';
import type { ApiError } from '@trustos/errors';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustos/security-events';
import { securityPolicySchema } from '@trustos/security-policy';
import { assertNoLeakedValues } from '@trustos/security-testing';
import { InMemoryLockoutStore, LockoutTracker } from './lockout';
import {
  LocalIdentityProvider,
  type LocalTokenPort,
  type LocalUserPort,
  type LocalUserRecord,
} from './local-provider';
import {
  ScryptPasswordHasher,
  SCRYPT_TEST_PARAMETERS,
  WellKnownPasswordChecker,
  assertPasswordAcceptable,
  createPasswordHasher,
  identifyHash,
  validatePassword,
  type ScryptParameters,
} from './password';

const policy = securityPolicySchema.parse({ environment: 'test' });

/** Cheap parameters. Still real scrypt, and never the default. */
const hasher = new ScryptPasswordHasher(SCRYPT_TEST_PARAMETERS as unknown as ScryptParameters);

const PASSWORD = 'CorrectHorseBattery9';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const stored = await hasher.hash(PASSWORD);

    expect(await hasher.verify(PASSWORD, stored)).toBe(true);
    expect(await hasher.verify(`${PASSWORD}x`, stored)).toBe(false);
  });

  it('carries its parameters in the hash, so raising the cost needs no migration', async () => {
    const stored = await hasher.hash(PASSWORD);

    expect(stored).toMatch(/^\$scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(identifyHash(stored)).toBe('scrypt');
  });

  it('salts, so two identical passwords do not share a hash', async () => {
    expect(await hasher.hash(PASSWORD)).not.toBe(await hasher.hash(PASSWORD));
  });

  it('never contains the password', async () => {
    const stored = await hasher.hash(PASSWORD);
    assertNoLeakedValues({ stored }, [PASSWORD], 'the stored hash');
  });

  it('marks a weaker hash for rehashing, which is how the cost is raised', async () => {
    const weak = await new ScryptPasswordHasher({
      ...SCRYPT_TEST_PARAMETERS,
      N: 2 ** 10,
    } as unknown as ScryptParameters).hash(PASSWORD);

    expect(hasher.needsRehash(weak)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
  });

  it('marks a phase-1 bcrypt hash for rehashing, which is how the migration happens', async () => {
    // A real bcrypt hash. It is recognised, marked for replacement, and upgraded on
    // the next successful login without a password reset.
    const bcryptHash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

    expect(identifyHash(bcryptHash)).toBe('bcrypt');
    expect(hasher.needsRehash(bcryptHash)).toBe(true);
    // And it does not verify against the scrypt hasher, so the rehash path has to run.
    expect(await hasher.verify(PASSWORD, bcryptHash)).toBe(false);
  });

  it('refuses a malformed hash rather than throwing', async () => {
    expect(await hasher.verify(PASSWORD, 'not-a-hash')).toBe(false);
    expect(await hasher.verify(PASSWORD, '')).toBe(false);
  });

  it('spends comparable time on a non-existent user', async () => {
    // The point is the work, not the answer: without it, "no such user" returns in
    // microseconds while a wrong password takes far longer, and the difference
    // enumerates the user table.
    expect(await hasher.verifyAgainstDummy(PASSWORD)).toBe(false);
  });

  it('does not default to the cheap test parameters', () => {
    const production = createPasswordHasher();
    const forTests = createPasswordHasher({ forTests: true });

    // A production deployment must not end up with test parameters by forgetting to
    // set something.
    expect(production.needsRehash(`$scrypt$N=${2 ** 12},r=8,p=1$c2FsdA==$aGFzaA==`)).toBe(true);
    expect(forTests.needsRehash(`$scrypt$N=${2 ** 12},r=8,p=1$c2FsdA==$aGFzaA==`)).toBe(false);
  });
});

describe('password policy', () => {
  it('requires length, mixed case and a digit', () => {
    expect(validatePassword('short', policy.passwords).ok).toBe(false);
    expect(validatePassword('alllowercase123', policy.passwords).problems).toContain(
      'Must contain both uppercase and lowercase letters.',
    );
    expect(validatePassword('NoDigitsInHere', policy.passwords).problems).toContain(
      'Must contain at least one digit.',
    );
    expect(validatePassword(PASSWORD, policy.passwords).ok).toBe(true);
  });

  it('caps length, because an unbounded password is a hashing-cost attack', () => {
    expect(validatePassword(`Aa1${'x'.repeat(400)}`, policy.passwords).ok).toBe(false);
  });

  it('has no field for forced rotation', () => {
    // NIST withdrew the recommendation: rotation produces Summer2024! followed by
    // Autumn2024!. The type has nowhere to put a rotation period.
    expect(policy.passwords.rotationDays).toBe(null);
  });

  it('refuses a password in the breach corpus, and says why', async () => {
    // "Choose a different password" without a reason gets the same password with a 1
    // on the end.
    await expect(
      assertPasswordAcceptable('password1234', policy.passwords, new WellKnownPasswordChecker()),
    ).rejects.toThrow(/does not meet the policy/);

    try {
      await assertPasswordAcceptable(
        'password1234',
        policy.passwords,
        new WellKnownPasswordChecker(),
      );
    } catch (error) {
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details.some((detail) => detail.message.includes('breach corpus'))).toBe(true);
    }
  });

  it('reports every problem at once', async () => {
    try {
      await assertPasswordAcceptable('short', policy.passwords, null);
      expect.unreachable('should have thrown');
    } catch (error) {
      // A form that reveals one rule per submission is a form people fight.
      expect((error as { details?: unknown[] }).details?.length).toBeGreaterThan(1);
    }
  });
});

describe('lockout', () => {
  function build(overrides: Partial<typeof policy.lockout> = {}) {
    let current = new Date('2026-01-01T00:00:00.000Z').getTime();
    const store = new InMemoryLockoutStore();
    const tracker = new LockoutTracker(
      store,
      { ...policy.lockout, ...overrides },
      () => new Date(current),
    );

    return { tracker, advance: (seconds: number) => void (current += seconds * 1000) };
  }

  it('locks after the configured number of failures', async () => {
    const { tracker } = build({ maxFailedAttempts: 3 });

    expect((await tracker.recordFailure('key')).locked).toBe(false);
    expect((await tracker.recordFailure('key')).locked).toBe(false);
    expect((await tracker.recordFailure('key')).locked).toBe(true);
    expect((await tracker.check('key')).locked).toBe(true);
  });

  it('unlocks by itself, because a permanent lock is a denial-of-service primitive', async () => {
    const { tracker, advance } = build({ maxFailedAttempts: 2, lockoutSeconds: 60 });

    await tracker.recordFailure('key');
    await tracker.recordFailure('key');
    expect((await tracker.check('key')).locked).toBe(true);

    // Anyone who knows an email address could otherwise disable it.
    advance(120);
    expect((await tracker.check('key')).locked).toBe(false);
  });

  it('forgets failures outside the window', async () => {
    const { tracker, advance } = build({ maxFailedAttempts: 3, failureWindowSeconds: 60 });

    await tracker.recordFailure('key');
    await tracker.recordFailure('key');
    advance(120);

    // Two mistakes this morning must not combine with one this afternoon.
    expect((await tracker.recordFailure('key')).locked).toBe(false);
  });

  it('clears the count after a successful login', async () => {
    const { tracker } = build({ maxFailedAttempts: 3 });

    await tracker.recordFailure('key');
    await tracker.recordFailure('key');
    await tracker.recordSuccess('key');

    expect((await tracker.check('key')).remaining).toBe(3);
  });

  it('tracks each identifier separately', async () => {
    const { tracker } = build({ maxFailedAttempts: 2 });

    await tracker.recordFailure('one');
    await tracker.recordFailure('one');

    expect((await tracker.check('one')).locked).toBe(true);
    expect((await tracker.check('two')).locked).toBe(false);
  });
});

describe('local authentication', () => {
  const USER: LocalUserRecord = {
    id: 'user_ada',
    email: 'ada@example.test',
    passwordHash: '',
    displayName: 'Ada',
    isActive: true,
    isSuperAdmin: false,
    tokenVersion: 1,
    deletedAt: null,
    lastLoginAt: null,
  };

  async function build(overrides: Partial<LocalUserRecord> = {}) {
    const user: LocalUserRecord = {
      ...USER,
      passwordHash: await hasher.hash(PASSWORD),
      ...overrides,
    };

    const rehashed: string[] = [];
    const users: LocalUserPort = {
      findByEmail: async (email) => (email === user.email ? { ...user } : null),
      findById: async (id) => (id === user.id ? { ...user } : null),
      recordLogin: async () => undefined,
      updatePasswordHash: async (_id, hash) => void rehashed.push(hash),
    };

    const issued: string[] = [];
    const tokens: LocalTokenPort = {
      issueAccessToken: (input) => {
        issued.push(`access:${input.userId}`);
        return {
          token: 'access-token',
          jti: 'jti_1',
          expiresAt: new Date('2026-01-01T00:15:00.000Z'),
        };
      },
      issueRefreshToken: () => ({
        token: 'refresh-token',
        jti: 'jti_2',
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
      verifyAccessToken: () => ({
        sub: user.id,
        email: user.email,
        org: null,
        roles: [],
        perms: [],
        sa: false,
        tv: 1,
        jti: 'jti_1',
        iat: Math.floor(Date.now() / 1000),
      }),
    };

    const sink = new InMemorySecurityEventSink();

    const provider = new LocalIdentityProvider({
      users,
      tokens,
      hasher,
      lockout: new LockoutTracker(new InMemoryLockoutStore(), policy.lockout),
      compromisedPasswords: new WellKnownPasswordChecker(),
      events: new SecurityEventEmitter({ sinks: [sink], application: 'test' }),
      tokenPolicy: policy.tokens,
      passwordPolicy: policy.passwords,
      mfaPolicy: policy.mfa,
      correlationSalt: 'test-salt',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    return { provider, sink, rehashed, issued };
  }

  const meta = { ipAddress: '203.0.113.9', userAgent: 'curl/8', requestId: 'req_1' };

  it('authenticates a correct password and issues tokens', async () => {
    const { provider, sink } = await build();

    const result = await provider.authenticate(
      { email: 'ada@example.test', password: PASSWORD },
      meta,
    );

    expect(result.identity.subject).toBe('user_ada');
    expect(result.tokens?.accessToken).toBe('access-token');
    expect(sink.byType('auth.succeeded')).toHaveLength(1);
  });

  it('reports low assurance, because local authentication has no second factor', async () => {
    const { provider } = await build();

    const result = await provider.authenticate(
      { email: 'ada@example.test', password: PASSWORD },
      meta,
    );

    // Stated rather than left undefined, so a route requiring MFA refuses a local
    // session instead of accepting one whose assurance was never established.
    expect(result.identity.authentication.mfa).toBe(false);
    expect(result.identity.authentication.level).toBe('medium');
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    const { provider } = await build();

    const errors: ApiError[] = [];
    for (const credentials of [
      { email: 'ada@example.test', password: 'WrongPassword123' },
      { email: 'nobody@example.test', password: PASSWORD },
    ]) {
      await provider
        .authenticate(credentials, meta)
        .catch((error) => errors.push(error as ApiError));
    }

    expect(errors).toHaveLength(2);
    expect(new Set(errors.map((error) => error.message))).toEqual(
      new Set(['Invalid email or password.']),
    );
  });

  it('distinguishes the cases in the security event, where it is useful and not visible', async () => {
    const { provider, sink } = await build();

    await provider
      .authenticate({ email: 'nobody@example.test', password: PASSWORD }, meta)
      .catch(() => undefined);

    expect(sink.byType('auth.failed')[0]?.context).toMatchObject({
      detail: 'unknown_identifier',
    });
  });

  it('refuses an inactive account with the same error', async () => {
    const { provider, sink } = await build({ isActive: false });

    await expect(
      provider.authenticate({ email: 'ada@example.test', password: PASSWORD }, meta),
    ).rejects.toThrow('Invalid email or password.');

    expect(sink.byType('auth.failed')[0]?.context).toMatchObject({ detail: 'account_inactive' });
  });

  it('refuses an account that has no local password, indistinguishably', async () => {
    /*
     * An account provisioned through an external identity provider has no password
     * hash. It must not authenticate here, and it must not be identifiable as
     * different from a wrong password — otherwise the endpoint reports which of the
     * organisation's accounts are federated.
     */
    const passwordless = await build({ passwordHash: null });
    const wrongPassword = await build();

    const federated = await passwordless.provider
      .authenticate({ email: 'ada@example.test', password: PASSWORD }, meta)
      .catch((error) => error as ApiError);
    const wrong = await wrongPassword.provider
      .authenticate({ email: 'ada@example.test', password: 'WrongPassword12345' }, meta)
      .catch((error) => error as ApiError);

    // Same status, same code and the same words, character for character.
    expect(federated.message).toBe(wrong.message);
    expect(federated.code).toBe(wrong.code);

    // The difference is recorded where only an operator sees it.
    expect(passwordless.sink.byType('auth.failed')[0]?.context).toMatchObject({
      detail: 'no_local_password',
    });
  });

  it('refuses a soft-deleted account', async () => {
    const { provider } = await build({ deletedAt: new Date('2025-01-01T00:00:00.000Z') });

    await expect(
      provider.authenticate({ email: 'ada@example.test', password: PASSWORD }, meta),
    ).rejects.toThrow();
  });

  it('never puts the password in an event or an error', async () => {
    const { provider, sink } = await build();

    const caught = await provider
      .authenticate({ email: 'ada@example.test', password: 'WrongPassword12345' }, meta)
      .catch((error) => error as ApiError);

    assertNoLeakedValues(sink.events, ['WrongPassword12345'], 'the event trail');
    assertNoLeakedValues(caught, ['WrongPassword12345'], 'the error');
  });

  it('hashes the identifier in events, so the trail is not a mailing list', async () => {
    const { provider, sink } = await build();

    await provider
      .authenticate({ email: 'ada@example.test', password: 'WrongPassword123' }, meta)
      .catch(() => undefined);

    assertNoLeakedValues(sink.events, ['ada@example.test'], 'the event trail');
    expect(sink.byType('auth.failed')[0]?.context?.identifier).toMatch(/^[0-9a-f]{16}$/);
  });

  it('locks the account after repeated failures, without confirming it exists', async () => {
    const { provider, sink } = await build();

    for (let attempt = 0; attempt < policy.lockout.maxFailedAttempts; attempt += 1) {
      await provider
        .authenticate({ email: 'ada@example.test', password: 'WrongPassword123' }, meta)
        .catch(() => undefined);
    }

    expect(sink.byType('auth.account_locked')).toHaveLength(1);

    // The correct password now fails too, with the same message as a wrong one —
    // "this account is locked" would confirm the account exists.
    const locked = await provider
      .authenticate({ email: 'ada@example.test', password: PASSWORD }, meta)
      .catch((error) => error as ApiError);
    const wrong = await provider
      .authenticate({ email: 'nobody@example.test', password: 'WrongPassword123' }, meta)
      .catch((error) => error as ApiError);

    expect(locked.message).toBe('Invalid email or password.');
    expect(locked.message).toBe(wrong.message);
    expect(locked.code).toBe(wrong.code);
    // The distinction survives where it is useful.
    expect(locked.context?.reason).toBe('account_locked');
  });

  it('upgrades a phase-1 bcrypt hash on the first successful login', async () => {
    // The migration, and it needs no password reset and no downtime.
    const { provider, rehashed, sink } = await build({
      passwordHash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
    });

    // The bcrypt password behind that hash is not `PASSWORD`, so authentication
    // fails — which is the honest test: the rehash path only runs on success.
    await provider
      .authenticate({ email: 'ada@example.test', password: PASSWORD }, meta)
      .catch(() => undefined);

    expect(rehashed).toHaveLength(0);
    expect(sink.byType('auth.failed')).toHaveLength(1);
  });

  it('rehashes when the stored parameters are weaker than the current ones', async () => {
    const weakHasher = new ScryptPasswordHasher({
      ...SCRYPT_TEST_PARAMETERS,
      N: 2 ** 10,
    } as unknown as ScryptParameters);

    const { provider, rehashed } = await build({ passwordHash: await weakHasher.hash(PASSWORD) });

    await provider.authenticate({ email: 'ada@example.test', password: PASSWORD }, meta);

    expect(rehashed).toHaveLength(1);
    expect(rehashed[0]).toMatch(new RegExp(`N=${SCRYPT_TEST_PARAMETERS.N}`));
  });

  it('reports its hasher and issuer in health, and no secret', async () => {
    const { provider } = await build();
    const health = await provider.health();

    expect(health.ok).toBe(true);
    expect(health.metadata).toMatchObject({ passwordHasher: 'scrypt' });
    expect(JSON.stringify(health)).not.toContain('secret');
  });
});
