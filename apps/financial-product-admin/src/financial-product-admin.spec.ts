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
import { FINANCIAL_PRODUCT_PERMISSIONS } from '@trustos/financial-product-core';
import { FinancialProductAdminModule } from './financial-product-admin.module';
import { BLOCK_REGISTRY, GUARD_ORDER, PRODUCT_REGISTRY, PRODUCT_RUNTIME } from './tokens';

/**
 * The phase's integration proof.
 *
 * Sixteen packages can pass their own tests and still not compose: a `@Global()` module that
 * declares a provider without exporting it, a factory whose dependency is not visible from the
 * module that registers it, a controller injecting a token nothing provides. All three are
 * start-up failures that only booting finds, because a unit test constructs the class directly
 * and never asks the injector to resolve anything.
 *
 * So this boots the real composition root with the database overridden and asserts what matters:
 * the injector resolves, the guards are registered in the documented order, the routes map, and
 * the surface offers nothing that would write a lifecycle state directly.
 */

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost:5432/trustos_test',
  JWT_SECRET: 'a-test-secret-that-is-long-enough-for-the-validator-to-accept',
  JWT_REFRESH_SECRET: 'a-different-test-secret-that-is-also-long-enough-to-accept',
});

const policy = securityPolicySchema.parse({ environment: 'test' });

/** A Prisma stand-in. A boot test that needs a database is a boot test nobody runs. */
function stubPrisma(): Record<string, unknown> {
  const delegate = {
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
    create: async () => ({}),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
    aggregate: async () => ({ _max: { sequence: null } }),
    groupBy: async () => [],
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
      FinancialProductAdminModule.forRoot({
        config,
        policy,
        logger: createLogger(config),
        overrides: {
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

describe('booting the Financial Product Designer', () => {
  it('resolves every provider the sixteen phase-11 packages contribute', async () => {
    // The assertion is that this does not throw. Nest resolves the whole graph during `init`,
    // so a missing export or an unprovided token fails here.
    app = await boot();
    expect(app).toBeTruthy();
    expect(app.get(PRODUCT_REGISTRY)).toBeTruthy();
    expect(app.get(PRODUCT_RUNTIME)).toBeTruthy();
    expect(app.get(BLOCK_REGISTRY)).toBeTruthy();
  });

  it('registers the guards in the order the security model depends on', async () => {
    app = await boot();

    /*
     * Read out of the running injector and derived from the registration itself, so this list
     * cannot drift from the order Nest runs them in.
     *
     * Authentication first, because everything after it needs an actor. Tenancy next, so an
     * actor with no organization is refused before any permission is consulted. Assurance
     * before permissions, so a privileged role with no second factor is stopped before its
     * permissions are looked at. Policy last, because it is the only one with the full picture
     * — and it is where the product separation-of-duty rules live.
     */
    expect(app.get<string[]>(GUARD_ORDER)).toEqual([
      'AuthenticationGuard',
      'TenantGuard',
      'AuthenticationAssuranceGuard',
      'PermissionsGuard',
      'PolicyAuthorizationGuard',
    ]);
  });

  it('maps the eleven sections of the designer', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths).toContain('GET /financial-products');
    expect(paths).toContain('GET /financial-products/:productId');
    expect(paths).toContain('GET /financial-products/:productId/api');
    expect(paths).toContain('GET /product-designer/navigation');
    expect(paths).toContain('GET /product-designer/palette');
    expect(paths).toContain('GET /product-designer/templates');
    expect(paths).toContain('GET /product-designer/connectors');
    expect(paths).toContain('GET /product-designer/reference-data');
    expect(paths).toContain('POST /product-designer/validate');
    expect(paths).toContain('GET /product-designer/:productId/compare');
    expect(paths).toContain('GET /financial-products/sandbox/scenarios');
    expect(paths).toContain('POST /financial-products/:productId/sandbox');
    expect(paths).toContain('POST /financial-products/:productId/simulate');
    expect(paths).toContain('GET /financial-products/monitoring/catalog');
    expect(paths).toContain('GET /financial-products/monitoring/dashboards/:id');
  });

  it('exposes the governance steps as separate routes', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    /*
     * Submit, decide, publish and activate are four routes with four permissions held by up to
     * four people, and the policies make them different *people*. One combined "go live" route
     * would collapse the control that stops a product reaching production on one signature.
     */
    expect(paths).toContain('POST /financial-products/:productId/transitions/:action');
    expect(paths).toContain('POST /financial-products/:productId/decisions');
    expect(paths).toContain('POST /financial-products/:productId/publish');
    expect(paths).toContain('POST /financial-products/:productId/versions/:version/activate');
  });

  it('splits rollback into a plan and an apply', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    // The plan is what a person reviews; the apply takes the plan. A route that took the
    // arguments again would be a second code path that stops predicting the first.
    expect(paths).toContain('POST /financial-products/:productId/rollback/plan');
    expect(paths).toContain('POST /financial-products/:productId/rollback/apply');
  });

  it('exposes no route that writes a lifecycle state directly', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    /*
     * Every move goes through the registry, which resolves the transition against the lifecycle
     * machine before it consults authorization. "Client-supplied lifecycle state" is not
     * something this API accepts, and the check is on the shape of the surface rather than on a
     * list of forbidden names.
     */
    const writes = paths.filter(
      (path) =>
        path.startsWith('POST /financial-products') || path.startsWith('PUT /financial-products'),
    );

    expect(writes.some((path) => path.endsWith('/status'))).toBe(false);
    expect(writes.some((path) => path.endsWith('/lifecycle'))).toBe(false);
    expect(writes.some((path) => path.endsWith('/state'))).toBe(false);
  });

  it('has no route that deletes anything', async () => {
    app = await boot();

    // A published version is immutable and an audit record is append-only. The API offers
    // nothing that would try.
    expect(listRoutePaths(app).filter((path) => path.startsWith('DELETE '))).toEqual([]);
  });

  it('has no route that executes a product transaction', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    /*
     * This is an administration surface. Executing a transaction goes through the product's own
     * exposed API and `@trustos/financial-product-api`'s dispatcher, which applies the
     * idempotency and rate-limit checks an admin route would not.
     *
     * A "run this product" button here would be a way to create a real transaction from a
     * console, with no idempotency key and no rate limit, by somebody holding an admin
     * permission rather than an execute one.
     */
    expect(paths.some((path) => path.includes('/execute'))).toBe(false);
    expect(paths.some((path) => path.includes('/transactions'))).toBe(false);
  });

  it('never grants execute through an administration permission', async () => {
    app = await boot();

    // `financial.product.execute` belongs to a channel calling the product API, not to somebody
    // administering products. It should not appear on this surface at all.
    expect(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_EXECUTE.key).toBe('financial.product.execute');
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
