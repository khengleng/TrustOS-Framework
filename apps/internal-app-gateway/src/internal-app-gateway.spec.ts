import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustsystem/audit';
import { loadConfig } from '@trustsystem/config';
import { PrismaService } from '@trustsystem/database';
import { createLogger } from '@trustsystem/logging';
import { InMemorySecurityEventSink } from '@trustsystem/security-events';
import { securityPolicySchema } from '@trustsystem/security-policy';
import { CONSOLE_TEMPLATES, consoleCatalogFor } from '@trustsystem/governance-tool-core';
import { APP_CATALOG, GOVERNANCE_RUNTIME, GUARD_ORDER, RESOURCE_REGISTRY } from './tokens';
import { InternalAppGatewayModule } from './internal-app-gateway.module';

/**
 * The gateway's integration proof.
 *
 * Thirteen packages can pass their own tests and still not compose. This boots the real
 * composition root with the database overridden and asserts the four things that matter: the
 * injector resolves, the guards register in the documented order, the surface is exactly two
 * traffic routes, and nothing on it takes a path or a resource id from the caller.
 */

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost:5432/trustos_test',
  JWT_SECRET: 'a-test-secret-that-is-long-enough-for-the-validator-to-accept',
  JWT_REFRESH_SECRET: 'a-different-test-secret-that-is-also-long-enough-to-accept',
});

const policy = securityPolicySchema.parse({ environment: 'test' });

function stubPrisma(): Record<string, unknown> {
  const delegate = {
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
    create: async () => ({}),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
  };

  return {
    securityEvent: delegate,
    auditLog: delegate,
    organizationMember: delegate,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    onModuleInit: async () => undefined,
    onModuleDestroy: async () => undefined,
    enableShutdownHooks: () => undefined,
  };
}

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      InternalAppGatewayModule.forRoot({
        config,
        policy,
        logger: createLogger(config),
        environment: 'dev',
        overrides: {
          apps: consoleCatalogFor('dev'),
          securityEventSinks: [new InMemorySecurityEventSink()],
          auditService: new AuditService({ sink: new InMemoryAuditSink() }),
        },
      }),
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(stubPrisma())
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

describe('booting the internal app gateway', () => {
  it('resolves every provider the thirteen phase-12 packages contribute', async () => {
    app = await boot();
    expect(app.get(APP_CATALOG)).toBeTruthy();
    expect(app.get(GOVERNANCE_RUNTIME)).toBeTruthy();
    expect(app.get(RESOURCE_REGISTRY)).toBeTruthy();
  });

  it('registers the guards in the order the security model depends on', async () => {
    app = await boot();

    expect(app.get<string[]>(GUARD_ORDER)).toEqual([
      'AuthenticationGuard',
      'TenantGuard',
      'AuthenticationAssuranceGuard',
      'PermissionsGuard',
      'PolicyAuthorizationGuard',
    ]);
  });

  it('exposes exactly two traffic routes', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    /*
     * One for reads, one for everything else.
     *
     * A gateway with a route per namespace is a gateway where a namespace eventually grows its
     * own auth — which is the failure the single-entrance design exists to prevent.
     */
    expect(paths).toContain('POST /internal/v1/apps/:appId/data/:dataSourceId');
    expect(paths).toContain('POST /internal/v1/apps/:appId/actions/:actionId');

    const posts = paths.filter((path) => path.startsWith('POST '));
    expect(posts).toHaveLength(2);
  });

  it('takes a declared id, never a path or a resource id, from the caller', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    // `:dataSourceId` and `:actionId` are declared ids the application's own definition
    // contains. A route with `:resourceId` or `:path` would be a route through which an
    // application reaches something it never declared.
    for (const path of paths) {
      expect(path).not.toContain(':resourceId');
      expect(path).not.toContain(':path');
      expect(path).not.toContain('*');
    }
  });

  it('has no route that deletes anything', async () => {
    app = await boot();
    expect(listRoutePaths(app).filter((path) => path.startsWith('DELETE '))).toEqual([]);
  });

  it('registers no resources by default', async () => {
    // A gateway shipping a populated resource registry would be shipping somebody's database
    // credentials and access classes.
    app = await boot();
    expect(app.get<{ size(): number }>(RESOURCE_REGISTRY).size()).toBe(0);
  });

  it('serves one environment, fixed at boot', async () => {
    app = await boot();
    const catalog = app.get<{ list(environment: 'dev' | 'uat' | 'prod'): unknown[] }>(APP_CATALOG);

    /*
     * Counted against the template list rather than a literal. The point of the test is the second
     * assertion — that another environment's catalog is empty — and a hard-coded count made it
     * fail every time a template was added, which teaches people to update the number rather than
     * to read what the test is for.
     */
    expect(catalog.list('dev')).toHaveLength(CONSOLE_TEMPLATES.length);
    // There is no request field that selects an environment, and the catalog for another one is
    // empty because this instance never loaded it.
    expect(catalog.list('prod')).toHaveLength(0);
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
