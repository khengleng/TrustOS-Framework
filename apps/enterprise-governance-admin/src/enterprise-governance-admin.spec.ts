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
import { EnterpriseGovernanceAdminModule } from './enterprise-governance-admin.module';
import {
  API_CATALOG,
  BACKUP_INVENTORY,
  CONSUMER_REGISTRY,
  DATA_CATALOG,
  GUARD_ORDER,
  POLICY_ENGINE,
  SERVICE_REGISTRY,
} from './tokens';
import { ENTERPRISE_PERMISSIONS, SEGREGATED_PAIRS, segregationViolations } from './permissions';

/**
 * Phase 13's integration proof.
 *
 * Thirty packages across five domains can each pass their own tests and still fail to compose: a
 * factory whose dependency is not visible from the module registering it, a controller injecting a
 * token nothing provides. Those are start-up failures that only booting finds, because a unit test
 * constructs a class directly and never asks the injector to resolve anything.
 *
 * So this boots the real composition root with the database stubbed and asserts what matters: the
 * injector resolves, the guards are in the documented order, the routes map, and the surface offers
 * nothing that would let governance be changed by one person or bypassed entirely.
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
      EnterpriseGovernanceAdminModule.forRoot({
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

describe('booting the Enterprise Governance Console', () => {
  it('resolves every provider the thirty phase-13 packages contribute', async () => {
    // The assertion is that this does not throw: Nest resolves the whole graph during `init`.
    app = await boot();

    expect(app.get(DATA_CATALOG)).toBeTruthy();
    expect(app.get(POLICY_ENGINE)).toBeTruthy();
    expect(app.get(SERVICE_REGISTRY)).toBeTruthy();
    expect(app.get(API_CATALOG)).toBeTruthy();
    expect(app.get(CONSUMER_REGISTRY)).toBeTruthy();
    expect(app.get(BACKUP_INVENTORY)).toBeTruthy();
  });

  it('registers the guards in the order the security model depends on', async () => {
    app = await boot();

    /*
     * Derived from the registration itself, so it cannot drift from the order Nest runs them in.
     * Authentication first, because everything after needs an actor. Tenancy next, so an actor
     * with no organization is refused before any permission is consulted. Assurance before
     * permissions, so a privileged role with no second factor is stopped before its permissions
     * are looked at. Policy last, because it is the only one with the full picture.
     */
    expect(app.get<string[]>(GUARD_ORDER)).toEqual([
      'AuthenticationGuard',
      'TenantGuard',
      'AuthenticationAssuranceGuard',
      'PermissionsGuard',
      'PolicyAuthorizationGuard',
    ]);
  });

  it('maps the five sections of the console', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths).toContain('GET /enterprise/data/catalog');
    expect(paths).toContain('GET /enterprise/data/lineage/:entryId');
    expect(paths).toContain('GET /enterprise/policies');
    expect(paths).toContain('GET /enterprise/apis');
    expect(paths).toContain('GET /enterprise/continuity');
  });
});

describe('the shape of the surface', () => {
  it('keeps simulating and deciding as separate routes', async () => {
    /*
     * One route with a `dryRun` flag would be smaller and worse. The flag defaults somewhere, and
     * a mistake in the default is either an unrecorded decision or an enforced draft.
     */
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths).toContain('POST /enterprise/policies/simulate');
    expect(paths).toContain('POST /enterprise/policies/decide');
  });

  it('offers no route that edits an active policy version', async () => {
    /*
     * Versions are immutable in the registry. A route that could edit one would make every
     * decision record unre-derivable: the log would name a version whose contents had since
     * changed, and re-deriving it would produce a different answer.
     */
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths.some((path) => path.startsWith('PUT /enterprise/policies'))).toBe(false);
    expect(paths.some((path) => path.startsWith('PATCH /enterprise/policies'))).toBe(false);
  });

  it('has no route that deletes anything', async () => {
    // An audit record is append-only, a policy version is immutable, and a backup record of a
    // failed job is exactly the record somebody would want gone.
    app = await boot();
    expect(listRoutePaths(app).filter((path) => path.startsWith('DELETE '))).toEqual([]);
  });

  it('proposes a classification change rather than applying one', async () => {
    /*
     * The route records a proposal. Applying it needs the approval permission, held by somebody
     * else — a classification a proposer can apply is a classification nobody reviews.
     */
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths).toContain('POST /enterprise/data/catalog/:entryId/classification');
    expect(paths.some((path) => path.includes('classification/apply'))).toBe(false);
  });

  it('exposes the compatibility check as a read', async () => {
    /*
     * Anybody who may see the catalog may check whether a change breaks. Behind the publish
     * permission, the check would happen once — by the person publishing, at the moment they are
     * least inclined to hear the answer.
     */
    app = await boot();
    expect(listRoutePaths(app)).toContain('GET /enterprise/apis/:apiId/compatibility');
  });
});

describe('segregation of duties', () => {
  it('names the pairs no role may hold together', () => {
    // Each pair is a proposer and an approver. Holding both collapses a two-person control into
    // one person, and the collapse looks in a role definition like somebody being given what they
    // need to do their job.
    expect(SEGREGATED_PAIRS).toHaveLength(3);
  });

  it('catches a role holding both halves', () => {
    const violations = segregationViolations([
      {
        name: 'data-steward',
        permissions: [
          ENTERPRISE_PERMISSIONS.DATA_CLASSIFY.key,
          ENTERPRISE_PERMISSIONS.DATA_CLASSIFY_APPROVE.key,
        ],
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.role).toBe('data-steward');
  });

  it('accepts a proposer and an approver as separate roles', () => {
    const violations = segregationViolations([
      { name: 'data-steward', permissions: [ENTERPRISE_PERMISSIONS.DATA_CLASSIFY.key] },
      { name: 'data-governance', permissions: [ENTERPRISE_PERMISSIONS.DATA_CLASSIFY_APPROVE.key] },
    ]);

    expect(violations).toHaveLength(0);
  });

  it('separates authoring a policy from activating one', () => {
    /*
     * A policy is a rule that governs everybody else. One person writing and enacting it is
     * unreviewed rule-making, and the controller refuses it a second time against the author id —
     * the permission split alone would not stop a person who holds both roles legitimately over
     * different policy sets.
     */
    const violations = segregationViolations([
      {
        name: 'policy-admin',
        permissions: [
          ENTERPRISE_PERMISSIONS.POLICY_AUTHOR.key,
          ENTERPRISE_PERMISSIONS.POLICY_ACTIVATE.key,
        ],
      },
    ]);

    expect(violations[0]?.pair).toEqual([
      ENTERPRISE_PERMISSIONS.POLICY_AUTHOR.key,
      ENTERPRISE_PERMISSIONS.POLICY_ACTIVATE.key,
    ]);
  });

  it('separates requesting a reveal from approving one', () => {
    // A role holding both can read any restricted value with nobody else involved.
    const violations = segregationViolations([
      {
        name: 'support-lead',
        permissions: [
          ENTERPRISE_PERMISSIONS.DATA_REVEAL.key,
          ENTERPRISE_PERMISSIONS.DATA_REVEAL_APPROVE.key,
        ],
      },
    ]);

    expect(violations).toHaveLength(1);
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
