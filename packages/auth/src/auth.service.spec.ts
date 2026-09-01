import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '@trustsystem/config';
import type { ApiError } from '@trustsystem/errors';
import { AuthService } from './auth.service';
import { TokenService, hashRefreshToken } from './tokens';
import { hashPassword } from './password';
import type { AuthEvent } from './events';
import {
  InMemoryMembershipResolver,
  InMemoryRefreshTokenStore,
  InMemoryUserStore,
} from './testing/in-memory-stores';

const PASSWORD = 'CorrectHorse7Battery';

const config: AppConfig = loadConfig({ source: { NODE_ENV: 'test' } });

describe('AuthService', () => {
  let users: InMemoryUserStore;
  let refreshTokens: InMemoryRefreshTokenStore;
  let memberships: InMemoryMembershipResolver;
  let events: AuthEvent[];
  let service: AuthService;

  beforeEach(() => {
    users = new InMemoryUserStore();
    refreshTokens = new InMemoryRefreshTokenStore();
    memberships = new InMemoryMembershipResolver();
    events = [];
    service = new AuthService({
      config,
      users,
      refreshTokens,
      memberships,
      events: { emit: (event) => void events.push(event) },
    });
  });

  const seedUser = async (overrides: Record<string, unknown> = {}) =>
    users.seed({
      email: 'ada@example.com',
      passwordHash: await hashPassword(PASSWORD, config.auth.passwordHashRounds),
      ...overrides,
    });

  const eventTypes = () => events.map((event) => event.type);

  // ---------------------------------------------------------------------------

  describe('register', () => {
    it('creates a user and returns a usable token pair', async () => {
      const result = await service.register({ email: 'Ada@Example.com ', password: PASSWORD });

      expect(result.user.email).toBe('ada@example.com');
      expect(result.tokens.tokenType).toBe('Bearer');
      expect(result.tokens.expiresIn).toBe(config.auth.accessTokenTtlSeconds);
      expect(eventTypes()).toContain('auth.registered');
    });

    it('never returns the password hash', async () => {
      const result = await service.register({ email: 'ada@example.com', password: PASSWORD });
      expect(JSON.stringify(result.user)).not.toContain('$2');
      expect('passwordHash' in result.user).toBe(false);
    });

    it('stores a hash, not the password', async () => {
      await service.register({ email: 'ada@example.com', password: PASSWORD });
      const stored = await users.findByEmail('ada@example.com');
      expect(stored?.passwordHash).not.toContain(PASSWORD);
      expect(stored?.passwordHash.startsWith('$2')).toBe(true);
    });

    it('rejects a weak password before touching the database', async () => {
      const error = await captureError(() =>
        service.register({ email: 'ada@example.com', password: 'short' }),
      );

      expect(error.code).toBe('validation_error');
      // The generic message is what the caller sees; the specifics live in
      // `details`, keyed by field, so a form can show them inline.
      expect(error.message).toBe('The request payload failed validation.');
      expect(error.details?.[0]?.message).toMatch(/at least 12 characters/);
      expect(await users.findByEmail('ada@example.com')).toBeNull();
    });

    it('rejects a duplicate registration with conflict', async () => {
      await seedUser();
      const error = await captureError(() =>
        service.register({ email: 'ada@example.com', password: PASSWORD }),
      );
      expect(error.code).toBe('conflict');
    });
  });

  // ---------------------------------------------------------------------------

  describe('login', () => {
    it('refuses an account that has no local password', async () => {
      // An account provisioned through an identity provider signs in there, not here.
      await seedUser({ passwordHash: null });

      await expect(service.login({ email: 'ada@example.com', password: PASSWORD })).rejects.toThrow(
        /incorrect/i,
      );
    });

    it('gives that refusal the same shape as a wrong password', async () => {
      // "This address exists but signs in elsewhere" is exactly what an enumeration
      // attack is looking for, so the two refusals must not be tellable apart.
      await seedUser({ passwordHash: null });
      const noLocalPassword = await service
        .login({ email: 'ada@example.com', password: PASSWORD })
        .catch((error: Error) => error.message);

      await users.clear?.();
      await seedUser();
      const wrongPassword = await service
        .login({ email: 'ada@example.com', password: 'not-the-password' })
        .catch((error: Error) => error.message);

      expect(noLocalPassword).toBe(wrongPassword);
    });

    it('authenticates a valid credential pair', async () => {
      await seedUser();
      const result = await service.login({ email: 'ada@example.com', password: PASSWORD });
      expect(result.user.email).toBe('ada@example.com');
      expect(eventTypes()).toContain('auth.login');
    });

    it('gives the same answer for a wrong password and an unknown account', async () => {
      await seedUser();

      const wrongPassword = await captureError(() =>
        service.login({ email: 'ada@example.com', password: 'WrongPassword123' }),
      );
      const unknownUser = await captureError(() =>
        service.login({ email: 'nobody@example.com', password: PASSWORD }),
      );

      expect(wrongPassword.code).toBe('unauthorized');
      expect(unknownUser.code).toBe('unauthorized');
      expect(wrongPassword.message).toBe(unknownUser.message);
    });

    it('records a failed attempt for the audit trail', async () => {
      await seedUser();
      await captureError(() =>
        service.login({ email: 'ada@example.com', password: 'Wrong1234567' }),
      );

      const failure = events.find((event) => event.type === 'auth.login_failed');
      expect(failure?.metadata?.reason).toBe('bad_password');
      expect(JSON.stringify(failure)).not.toContain('Wrong1234567');
    });

    it('refuses a deactivated or soft-deleted account', async () => {
      await seedUser({ isActive: false });
      expect(
        (await captureError(() => service.login({ email: 'ada@example.com', password: PASSWORD })))
          .code,
      ).toBe('unauthorized');

      users = new InMemoryUserStore();
      service = new AuthService({ config, users, refreshTokens, memberships });
      await seedUser({ deletedAt: new Date() });
      expect(
        (await captureError(() => service.login({ email: 'ada@example.com', password: PASSWORD })))
          .code,
      ).toBe('unauthorized');
    });

    it('selects the only organization automatically', async () => {
      const user = await seedUser();
      memberships.add(user.id, { organizationId: 'org_acme' });

      const result = await service.login({ email: 'ada@example.com', password: PASSWORD });
      const claims = new TokenService(config).verifyAccessToken(result.tokens.accessToken);
      expect(claims.org).toBe('org_acme');
    });

    it('leaves the token unscoped when the user belongs to several organizations', async () => {
      const user = await seedUser();
      memberships.add(user.id, { organizationId: 'org_acme' });
      memberships.add(user.id, { organizationId: 'org_beta' });

      const result = await service.login({ email: 'ada@example.com', password: PASSWORD });
      const claims = new TokenService(config).verifyAccessToken(result.tokens.accessToken);
      expect(claims.org).toBeNull();
      expect(result.organizations).toHaveLength(2);
    });

    it('refuses to log in to an organization the user does not belong to', async () => {
      const user = await seedUser();
      memberships.add(user.id, { organizationId: 'org_acme' });

      const error = await captureError(() =>
        service.login({
          email: 'ada@example.com',
          password: PASSWORD,
          organizationId: 'org_rival',
        }),
      );
      expect(error.code).toBe('forbidden');
    });

    it('re-hashes a password stored with an outdated cost factor', async () => {
      const weak = await hashPassword(PASSWORD, 10);
      await seedUser({ passwordHash: weak });

      const strongConfig = loadConfig({
        source: { NODE_ENV: 'test', PASSWORD_HASH_ROUNDS: '12' },
      });
      const upgrading = new AuthService({
        config: strongConfig,
        users,
        refreshTokens,
        memberships,
        events: { emit: (event) => void events.push(event) },
      });

      await upgrading.login({ email: 'ada@example.com', password: PASSWORD });

      const stored = await users.findByEmail('ada@example.com');
      expect(stored?.passwordHash).not.toBe(weak);
      expect(stored?.passwordHash).toMatch(/^\$2[aby]?\$12\$/);
      expect(eventTypes()).toContain('auth.password_rehashed');
      // Three bcrypt operations, one of them at cost 12 deliberately. The five-second
      // default is a deadline for a unit test, not for real key stretching, and this
      // timed out during full-suite runs on a tree where nothing was wrong.
    }, 60_000);
  });

  // ---------------------------------------------------------------------------

  describe('refresh token rotation', () => {
    it('issues a new pair and invalidates the presented token', async () => {
      await seedUser();
      const first = await service.login({ email: 'ada@example.com', password: PASSWORD });

      const second = await service.refresh(first.tokens.refreshToken);

      expect(second.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
      const oldRecord = await refreshTokens.findByHash(hashRefreshToken(first.tokens.refreshToken));
      expect(oldRecord?.revokedReason).toBe('rotated');
      expect(refreshTokens.liveTokens()).toHaveLength(1);
    });

    it('keeps the rotation family stable so the chain is auditable', async () => {
      await seedUser();
      const first = await service.login({ email: 'ada@example.com', password: PASSWORD });
      const second = await service.refresh(first.tokens.refreshToken);

      const before = await refreshTokens.findByHash(hashRefreshToken(first.tokens.refreshToken));
      const after = await refreshTokens.findByHash(hashRefreshToken(second.tokens.refreshToken));
      expect(after?.familyId).toBe(before?.familyId);
    });

    it('revokes the whole family when a rotated token is replayed', async () => {
      await seedUser();
      const first = await service.login({ email: 'ada@example.com', password: PASSWORD });
      await service.refresh(first.tokens.refreshToken);

      const replay = await captureError(() => service.refresh(first.tokens.refreshToken));

      expect(replay.code).toBe('unauthorized');
      expect(refreshTokens.liveTokens()).toHaveLength(0);
      expect(eventTypes()).toContain('auth.token_reuse_detected');
    });

    it('attributes a reuse alert to the organization whose admins must see it', async () => {
      const user = await seedUser();
      memberships.add(user.id, { organizationId: 'org_acme' });
      const first = await service.login({ email: 'ada@example.com', password: PASSWORD });
      await service.refresh(first.tokens.refreshToken);
      await captureError(() => service.refresh(first.tokens.refreshToken));

      const alert = events.find((event) => event.type === 'auth.token_reuse_detected');
      // Without this, the alert is invisible in an organization-scoped audit view.
      expect(alert?.organizationId).toBe('org_acme');
    });

    it('rejects a token this server never issued', async () => {
      await seedUser();
      const foreign = new TokenService(
        loadConfig({
          source: {
            NODE_ENV: 'production',
            PORT: '3000',
            DATABASE_URL: 'postgresql://u:p@h:5432/d',
            JWT_SECRET: 'x'.repeat(40),
            JWT_REFRESH_SECRET: 'y'.repeat(40),
            LOG_LEVEL: 'info',
          },
        }),
      ).issueRefreshToken({
        userId: 'user_1',
        familyId: 'fam',
        organizationId: null,
        tokenVersion: 0,
      });

      expect((await captureError(() => service.refresh(foreign.token))).code).toBe('unauthorized');
    });

    it('rejects an expired refresh token', async () => {
      await seedUser();
      const login = await service.login({ email: 'ada@example.com', password: PASSWORD });

      const record = await refreshTokens.findByHash(hashRefreshToken(login.tokens.refreshToken));
      if (record) record.expiresAt = new Date(Date.now() - 1000);

      expect((await captureError(() => service.refresh(login.tokens.refreshToken))).code).toBe(
        'unauthorized',
      );
    });

    it('rejects a refresh after every session was revoked', async () => {
      const user = await seedUser();
      const login = await service.login({ email: 'ada@example.com', password: PASSWORD });

      await service.revokeAllSessions(user.id, 'admin');

      expect((await captureError(() => service.refresh(login.tokens.refreshToken))).code).toBe(
        'unauthorized',
      );
    });

    it('picks up permission changes on refresh rather than waiting for a new login', async () => {
      const user = await seedUser();
      memberships.add(user.id, {
        organizationId: 'org_acme',
        roles: ['administrator'],
        permissions: ['organization.read', 'audit.read'],
      });

      const login = await service.login({ email: 'ada@example.com', password: PASSWORD });
      memberships.remove(user.id, 'org_acme');
      memberships.add(user.id, {
        organizationId: 'org_acme',
        roles: ['operator'],
        permissions: ['organization.read'],
      });

      const refreshed = await service.refresh(login.tokens.refreshToken);
      const claims = new TokenService(config).verifyAccessToken(refreshed.tokens.accessToken);
      expect(claims.perms).toEqual(['organization.read']);
    });

    it('falls back to no organization when membership was removed', async () => {
      const user = await seedUser();
      memberships.add(user.id, { organizationId: 'org_acme' });
      const login = await service.login({ email: 'ada@example.com', password: PASSWORD });

      memberships.remove(user.id, 'org_acme');

      const refreshed = await service.refresh(login.tokens.refreshToken);
      const claims = new TokenService(config).verifyAccessToken(refreshed.tokens.accessToken);
      expect(claims.org).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------

  describe('logout', () => {
    it('revokes the session family and is idempotent', async () => {
      await seedUser();
      const login = await service.login({ email: 'ada@example.com', password: PASSWORD });

      await service.logout(login.tokens.refreshToken);
      expect(refreshTokens.liveTokens()).toHaveLength(0);

      // A second logout with the same token must not throw.
      await expect(service.logout(login.tokens.refreshToken)).resolves.toBeUndefined();
      expect(eventTypes().filter((type) => type === 'auth.logout')).toHaveLength(2);
    });

    it('cannot be used to refresh afterwards', async () => {
      await seedUser();
      const login = await service.login({ email: 'ada@example.com', password: PASSWORD });
      await service.logout(login.tokens.refreshToken);

      expect((await captureError(() => service.refresh(login.tokens.refreshToken))).code).toBe(
        'unauthorized',
      );
    });

    it('tolerates a malformed token', async () => {
      await expect(service.logout('not-a-jwt')).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------

  describe('selectOrganization', () => {
    it('mints a token scoped to the chosen organization', async () => {
      const user = await seedUser();
      memberships.add(user.id, { organizationId: 'org_acme' });
      memberships.add(user.id, { organizationId: 'org_beta', permissions: ['audit.read'] });

      const result = await service.selectOrganization(user.id, 'org_beta');
      const claims = new TokenService(config).verifyAccessToken(result.tokens.accessToken);

      expect(claims.org).toBe('org_beta');
      expect(claims.perms).toEqual(['audit.read']);
      expect(eventTypes()).toContain('auth.organization_selected');
    });

    it('refuses an organization the user does not belong to', async () => {
      const user = await seedUser();
      expect(
        (await captureError(() => service.selectOrganization(user.id, 'org_rival'))).code,
      ).toBe('forbidden');
    });
  });

  // ---------------------------------------------------------------------------

  it('does not fail a login because the audit sink failed', async () => {
    await seedUser();
    const failing = new AuthService({
      config,
      users,
      refreshTokens,
      memberships,
      events: {
        emit: vi.fn(() => {
          throw new Error('audit sink unavailable');
        }),
      },
    });

    await expect(
      failing.login({ email: 'ada@example.com', password: PASSWORD }),
    ).resolves.toMatchObject({ user: { email: 'ada@example.com' } });
  });
});

async function captureError(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
    throw new Error('expected the call to reject');
  } catch (error) {
    return error as ApiError;
  }
}
