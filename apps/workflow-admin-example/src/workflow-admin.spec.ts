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
import { WorkflowAdminModule } from './workflow-admin.module';
import { GUARD_ORDER } from './tokens';

/**
 * The phase's integration proof.
 *
 * All ten packages can pass their own tests and still not compose: a `@Global()` module that
 * declares a provider without exporting it, a factory whose dependency is not visible from
 * the module that registers it, a controller injecting a token nothing provides. All three
 * are start-up failures that only booting finds, because a unit test constructs the class
 * directly and never asks the injector to resolve anything.
 *
 * So this boots the real composition root with the database overridden and asserts the three
 * things that matter: the injector resolves, the guards are registered in the documented
 * order, and the routes map.
 */

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost:5432/trustos_test',
  JWT_SECRET: 'a-test-secret-that-is-long-enough-for-the-validator-to-accept',
  JWT_REFRESH_SECRET: 'a-different-test-secret-that-is-also-long-enough-to-accept',
});

const policy = securityPolicySchema.parse({ environment: 'test' });

/**
 * A Prisma stand-in.
 *
 * Every delegate the module's factories touch, answering emptily. Overridden rather than
 * connected, because a boot test that needs a database is a boot test nobody runs.
 */
function stubPrisma(): Record<string, unknown> {
  const delegate = {
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
    create: async () => ({}),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({ position: 0 }),
    aggregate: async () => ({ _max: { sequence: null } }),
    groupBy: async () => [],
  };

  return {
    workflowDefinition: delegate,
    workflowVersion: delegate,
    workflowInstance: delegate,
    workflowTask: delegate,
    workflowDecision: delegate,
    workflowEvent: delegate,
    workflowComment: delegate,
    workflowCommentAmendment: delegate,
    workflowAttachment: delegate,
    workflowSla: delegate,
    workflowEscalation: delegate,
    workflowIdempotencyRecord: delegate,
    workflowAssignmentCursor: delegate,
    caseRecord: delegate,
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
      WorkflowAdminModule.forRoot({
        config,
        policy,
        logger: createLogger(config),
        overrides: {
          securityEventSinks: [new InMemorySecurityEventSink()],
          auditService: new AuditService({ sink: new InMemoryAuditSink() }),
          memberDirectory: {
            listByRole: async () => [],
            listByGroup: async () => [],
            isActiveMember: async () => false,
          },
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

describe('booting the workflow administration API', () => {
  it('resolves every provider the ten phase-5 packages contribute', async () => {
    // The assertion is that this does not throw. Nest resolves the whole graph during
    // `init`, so a missing export or an unprovided token fails here.
    app = await boot();
    expect(app).toBeTruthy();
  });

  it('registers the guards in the order the security model depends on', async () => {
    app = await boot();

    /*
     * Read out of the running injector and derived from the registration itself rather than
     * restated: the module wraps each guard provider in a helper that records the class name
     * as it is built, so this list cannot drift from the order Nest runs them in.
     *
     * Authentication first, because everything after it needs an actor. Tenancy next, so an
     * actor with no organization is refused before any permission is consulted. Assurance
     * before permissions, so a privileged role with no second factor is stopped before its
     * permissions are looked at. Policy last, because it is the only one with the full
     * picture — and it is where the workflow separation-of-duty rules live.
     */
    expect(app.get<string[]>(GUARD_ORDER)).toEqual([
      'AuthenticationGuard',
      'TenantGuard',
      'AuthenticationAssuranceGuard',
      'PermissionsGuard',
      'PolicyAuthorizationGuard',
    ]);
  });

  it('maps every administration route', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    // Section 24's portal: definitions and their governance, instances, overdue tasks, SLA
    // breaches, reassignment, cases, and complete history.
    expect(paths).toContain('GET /workflow/definitions');
    expect(paths).toContain('POST /workflow/definitions/drafts');
    expect(paths).toContain('POST /workflow/definitions/versions/:versionId/submit');
    expect(paths).toContain('POST /workflow/definitions/versions/:versionId/approve');
    expect(paths).toContain('POST /workflow/definitions/versions/:versionId/publish');
    expect(paths).toContain('POST /workflow/definitions/versions/:versionId/retire');
    expect(paths).toContain('GET /workflow/instances');
    expect(paths).toContain('GET /workflow/instances/:instanceId/history');
    expect(paths).toContain('POST /workflow/instances/:instanceId/actions/:action');
    expect(paths).toContain('GET /workflow/tasks/overdue');
    expect(paths).toContain('POST /workflow/tasks/:taskId/claim');
    expect(paths).toContain('POST /workflow/tasks/:taskId/reassign');
    expect(paths).toContain('GET /workflow/operations/instances/:instanceId/sla');
    expect(paths).toContain('GET /cases');
    expect(paths).toContain('GET /cases/:caseId/timeline');
  });

  it('exposes no route that sets a workflow state directly', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    /*
     * Every move goes through an action the definition declares, so "client-supplied
     * workflow state" is not something this API accepts.
     *
     * The check is on the *shape* of the surface rather than on a list of forbidden names:
     * there is no route ending in `/state`, and the only path segment that changes an
     * instance is `/actions/:action`.
     */
    const instanceWrites = paths.filter(
      (path) =>
        path.startsWith('POST /workflow/instances') || path.startsWith('PUT /workflow/instances'),
    );

    expect(instanceWrites.some((path) => path.endsWith('/state'))).toBe(false);
    expect(instanceWrites).toEqual([
      'POST /workflow/instances',
      'POST /workflow/instances/:instanceId/actions/:action',
      'POST /workflow/instances/:instanceId/cancel',
    ]);
  });

  it('exposes the definition lifecycle as three separate governance routes', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    /*
     * Submit, approve and publish are three routes with three permissions held by three
     * people — and `definitionGovernancePolicy` makes them three different *people*.
     *
     * One combined "activate" route would collapse the control that stops the engine being
     * circumvented: somebody who can author and publish can ship `allowSelfApproval: true`
     * and approve their own requests through it.
     */
    for (const step of ['submit', 'approve', 'publish']) {
      expect(paths, step).toContain(`POST /workflow/definitions/versions/:versionId/${step}`);
    }
  });

  it('has no route that deletes workflow history', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    // History is append-only — enforced by a database trigger — and the API offers nothing
    // that would try.
    expect(paths.filter((path) => path.startsWith('DELETE '))).toEqual([]);
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
