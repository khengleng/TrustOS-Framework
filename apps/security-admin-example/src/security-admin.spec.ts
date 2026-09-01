import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyService, InMemoryApiKeyStore } from '@trustsystem/api-keys';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import { loadConfig } from '@trustsystem/config';
import { PrismaService } from '@trustsystem/database';
import type { IdentityProvider, VerifiedIdentity } from '@trustsystem/identity';
import { createLogger } from '@trustsystem/logging';
import { InMemorySecurityEventSink } from '@trustsystem/security-events';
import { securityPolicySchema } from '@trustsystem/security-policy';
import { InMemoryServiceAccountStore, ServiceAccountService } from '@trustsystem/service-accounts';
import { InMemorySessionStore, SessionService } from '@trustsystem/session-security';
import { SecurityAdminModule } from './security-admin.module';
import { GUARD_ORDER } from './tokens';

/**
 * The phase's integration proof.
 *
 * A package can pass every one of its own tests and still be unusable: a `@Global()`
 * module that declares a provider without exporting it, a guard whose dependency is
 * not visible from the module that registers it, or a controller injecting a token
 * nothing provides — all three are start-up failures that only booting finds. Unit
 * tests cannot find them, because a unit test constructs the class directly and never
 * asks the injector to resolve anything.
 *
 * So this suite boots the real composition root with in-memory stores and asserts the
 * two things that matter: the injector resolves, and the guards are registered in the
 * order the security model depends on.
 */

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost:5432/trustos_test',
  JWT_SECRET: 'a-test-secret-that-is-long-enough-for-the-validator-to-accept',
  JWT_REFRESH_SECRET: 'a-different-test-secret-that-is-also-long-enough-to-accept',
});

const policy = securityPolicySchema.parse({ environment: 'test' });

/** A provider that authenticates nobody. The boot test never issues a request. */
const stubProvider: IdentityProvider = {
  name: 'stub',
  authenticate: async () => {
    throw new Error('not used');
  },
  validateAccessToken: async (): Promise<VerifiedIdentity> => {
    throw new Error('not used');
  },
  getProfile: async () => {
    throw new Error('not used');
  },
  logout: async () => undefined,
  revokeSessions: async () => 0,
  mapRoles: () => ({ roles: [], isSuperAdmin: false, unmapped: [] }),
  health: async () => ({ status: 'up' as const, details: { provider: 'stub' } }),
};

async function boot(): Promise<INestApplication> {
  const events = new InMemorySecurityEventSink();

  const moduleRef = await Test.createTestingModule({
    imports: [
      SecurityAdminModule.forRoot({
        config,
        policy,
        logger: createLogger(config),
        correlationSalt: 'a-salt-for-correlation-hashes-in-tests',
        overrides: {
          identityProvider: stubProvider,
          securityEventSinks: [events],
          auditService: new AuditService({ sink: new InMemoryAuditSink() }),
          sessionService: new SessionService({
            store: new InMemorySessionStore(),
            policy: policy.sessions,
            tokens: policy.tokens,
          }),
          apiKeyService: new ApiKeyService({
            store: new InMemoryApiKeyStore(),
            policy: policy.apiKeys,
            allowedScopes: ['payments:read', 'payments:write'],
            environment: 'test',
          }),
          serviceAccountService: new ServiceAccountService({
            store: new InMemoryServiceAccountStore(),
            policy: policy.apiKeys,
            allowedScopes: ['payments:read', 'payments:write'],
          }),
        },
      }),
    ],
  })
    // The one real dependency the controllers hold that a boot test cannot satisfy:
    // the security event controller reads the persisted trail. Overridden rather
    // than connected, because a boot test that needs a database is a boot test
    // nobody runs.
    .overrideProvider(PrismaService)
    .useValue({
      securityEvent: {
        findMany: async () => [],
        count: async () => 0,
        groupBy: async () => [],
      },
      $connect: async () => undefined,
      $disconnect: async () => undefined,
      onModuleInit: async () => undefined,
      onModuleDestroy: async () => undefined,
      enableShutdownHooks: () => undefined,
    })
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('booting the security administration API', () => {
  it('resolves every provider the eight phase-4 packages contribute', async () => {
    // The assertion is that this does not throw. Nest resolves the whole graph
    // during `init`, so a missing export or an unprovided token fails here.
    app = await boot();
    expect(app).toBeTruthy();
  });

  it('registers the guards in the order the security model depends on', async () => {
    app = await boot();

    // Read out of the running injector, and derived from the registration itself
    // rather than restated: the module wraps each guard provider in a helper that
    // records the class name as it is built, so this list cannot drift from the
    // order Nest will actually run them in.
    //
    // The order is the security model, not a style choice. Authentication first,
    // because everything after it needs an actor. Tenancy next, because an actor
    // with no organization can be refused before any permission is consulted.
    // Assurance *before* permissions, so a privileged role with no second factor is
    // stopped before its permissions are looked at. Policy last, because it is the
    // only one with the full picture. Reordering these is a security review.
    expect(app.get<string[]>(GUARD_ORDER)).toEqual([
      'AuthenticationGuard',
      'TenantGuard',
      'InteractiveRouteGuard',
      'AuthenticationAssuranceGuard',
      'PermissionsGuard',
      'ScopeGuard',
      'PolicyAuthorizationGuard',
    ]);
  });

  it('maps every security route', async () => {
    app = await boot();

    const paths = listRoutePaths(app);

    // Section 18's portal: identity status, sessions, keys, accounts, events.
    expect(paths).toContain('GET /security/identity/me');
    expect(paths).toContain('GET /security/identity/provider');
    expect(paths).toContain('GET /security/identity/policy');
    expect(paths).toContain('GET /security/sessions/mine');
    expect(paths).toContain('DELETE /security/sessions/:id');
    expect(paths).toContain('GET /security/api-keys');
    expect(paths).toContain('POST /security/api-keys/:id/rotate');
    expect(paths).toContain('DELETE /security/api-keys/:id');
    expect(paths).toContain('GET /security/service-accounts');
    expect(paths).toContain('GET /security/events');
  });

  it('exposes no route that could return a credential value', async () => {
    app = await boot();

    const paths = listRoutePaths(app);

    // Creation and rotation are the only two, and both are POST: there is no GET
    // anywhere in the surface that could hand back a stored secret, because no
    // stored secret exists to hand back.
    const credentialRoutes = paths.filter(
      (path) => path.includes('api-keys') || path.includes('service-accounts'),
    );
    const readable = credentialRoutes.filter((path) => path.startsWith('GET '));

    expect(readable).toEqual([
      'GET /security/api-keys',
      'GET /security/api-keys/:id/usage',
      'GET /security/service-accounts',
    ]);
  });
});

function listRoutePaths(app: INestApplication): string[] {
  const server = app.getHttpAdapter().getInstance() as {
    router?: { stack?: unknown[] };
    _router?: { stack?: unknown[] };
  };

  const stack = (server.router?.stack ?? server._router?.stack ?? []) as Array<{
    route?: { path?: string; methods?: Record<string, boolean> };
  }>;

  const paths: string[] = [];
  for (const layer of stack) {
    const path = layer.route?.path;
    if (!path) continue;
    for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
      if (enabled) paths.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return paths;
}
