import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import { loadConfig } from '@trustos/config';
import { PrismaService } from '@trustos/database';
import { createLogger } from '@trustos/logging';
import { InMemorySecurityEventSink } from '@trustos/security-events';
import { securityPolicySchema } from '@trustos/security-policy';
import { CONSOLE_TEMPLATES, consoleCatalogFor } from '@trustos/governance-tool-core';
import { APP_CATALOG, GOVERNANCE_RUNTIME, GUARD_ORDER, RESOURCE_REGISTRY } from './tokens';
import { GovernanceToolModule } from './governance-tool.module';

/**
 * The Governance Tool's integration proof.
 *
 * Boots the real composition root with the database overridden and asserts what matters: the
 * injector resolves, the guards register in the documented order, and — the property that keeps
 * the two applications separable — **this surface carries no traffic.** Reads and actions go
 * through the gateway, which is a different deployable with a different blast radius.
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
      GovernanceToolModule.forRoot({
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

describe('booting the Governance Tool', () => {
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

  it('maps the catalog and console surfaces', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths).toContain('GET /governance/apps');
    expect(paths).toContain('GET /governance/apps/by-resource/:resourceId');
    expect(paths).toContain('GET /governance/apps/reviews/overdue');
    expect(paths).toContain('GET /governance/apps/templates');
    expect(paths).toContain('GET /governance/apps/:appId/access');
    expect(paths).toContain('POST /governance/apps/from-template');
    expect(paths).toContain('POST /governance/apps/:appId/promotion/plan');
    expect(paths).toContain('GET /governance/consoles/:appId');
    expect(paths).toContain('GET /governance/consoles/:appId/masking');
    expect(paths).toContain('GET /governance/consoles/:appId/export-policy');
  });

  it('carries no traffic', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    /*
     * The property that keeps the two applications separable.
     *
     * The surface that lists what exists and the surface that reaches production data have
     * different blast radii. Running them in one process means one vulnerability reaches both.
     */
    expect(paths.some((path) => path.includes('/internal/v1/'))).toBe(false);
    expect(paths.some((path) => path.includes('/data/'))).toBe(false);
    expect(paths.some((path) => path.includes('/actions/'))).toBe(false);
  });

  it('plans a promotion rather than performing one', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    // The plan is what a person reviews. There is no route that applies one here — promotion
    // into a higher environment is a deployment, not a button.
    expect(paths).toContain('POST /governance/apps/:appId/promotion/plan');
    expect(paths.some((path) => path.endsWith('/promotion/apply'))).toBe(false);
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
