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
import { ServiceRegistry, runbookSchema, serviceSchema } from '@trustos/sre-core';
import { SliRegistry, sliDefinitionSchema, sliMeasurementSchema } from '@trustos/sli';
import { sloSchema } from '@trustos/slo';
import { SreOperationsConsoleModule } from './sre-operations-console.module';
import {
  HEALTH_BOARD,
  INCIDENT_MANAGER,
  SERVICE_REGISTRY,
  SLI_REGISTRY,
  GUARD_ORDER,
} from './tokens';
import type { SreState } from './controllers/operations.controller';
import { OperationsController } from './controllers/operations.controller';
import { SEGREGATED_PAIRS, SRE_PERMISSIONS } from './permissions';

const NOW = new Date('2026-06-01T12:00:00.000Z');

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

const runbook = runbookSchema.parse({
  runbookId: 'rb.outage',
  title: 'Service outage',
  trigger: 'The service reports unavailable for more than two minutes.',
  severityHint: 'SEV1',
  steps: [{ title: 'Confirm', action: 'Check readiness on every instance.', verification: null }],
  escalateTo: 'Platform on-call.',
  lastReviewedAt: '2026-05-01T00:00:00.000Z',
  ownerId: 'usr_platform',
});

const service = serviceSchema.parse({
  serviceId: 'payments.api',
  name: 'Payments API',
  description: 'Accepts payment requests and posts them to the ledger.',
  tier: 'tier_1',
  ownerTeam: 'payments',
  onCallRotation: 'payments-primary',
  runbookIds: ['rb.outage'],
  supportsProducts: ['merchant-wallet-basic'],
  environment: 'production',
  registeredAt: '2026-01-01T00:00:00.000Z',
  dependencies: [
    {
      dependencyId: 'ledger',
      kind: 'api',
      description: 'Posts a journal entry for every accepted payment.',
      critical: true,
      targetServiceId: null,
      degradedBehaviour: 'Payments are refused rather than accepted un-posted.',
      runbookId: 'rb.outage',
    },
  ],
});

const indicator = sliDefinitionSchema.parse({
  sliId: 'payments.api.availability',
  serviceId: 'payments.api',
  kind: 'availability',
  name: 'Payments API availability',
  goodEventDefinition: 'An HTTP request answered with a status below 500 within the timeout.',
  validEventDefinition: 'Every authenticated request that reached the service.',
  source: 'ingress access logs',
});

const objective = sloSchema.parse({
  sloId: 'payments.api.availability',
  serviceId: 'payments.api',
  sliId: 'payments.api.availability',
  name: 'Payments API availability',
  target: 99.9,
  windowDays: 30,
  ownerTeam: 'payments',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
});

function state(overrides: Partial<SreState> = {}): SreState {
  return { slos: [objective], measurements: [], incidents: [], ...overrides };
}

async function boot(sreState: SreState = state()): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SreOperationsConsoleModule.forRoot({
        config,
        policy,
        logger: createLogger(config),
        overrides: {
          securityEventSinks: [new InMemorySecurityEventSink()],
          auditService: new AuditService({ sink: new InMemoryAuditSink() }),
          serviceRegistry: new ServiceRegistry({ runbooks: [runbook], services: [service] }),
          slis: new SliRegistry([indicator]),
          state: sreState,
          now: () => NOW,
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

describe('booting the SRE Operations Console', () => {
  it('resolves the SRE packages against the real framework', async () => {
    app = await boot();

    expect(app.get(SERVICE_REGISTRY)).toBeTruthy();
    expect(app.get(HEALTH_BOARD)).toBeTruthy();
    expect(app.get(SLI_REGISTRY)).toBeTruthy();
    expect(app.get(INCIDENT_MANAGER)).toBeTruthy();
  });

  it('registers the guards in the documented order', async () => {
    app = await boot();

    expect(app.get<string[]>(GUARD_ORDER)).toEqual([
      'AuthenticationGuard',
      'TenantGuard',
      'AuthenticationAssuranceGuard',
      'PermissionsGuard',
      'PolicyAuthorizationGuard',
    ]);
  });
});

describe('what the console can and cannot do', () => {
  it('offers no route that acts on production', async () => {
    /*
     * No restart, no drain, no failover, no scale. Those belong behind the deployment's own
     * operational tooling, where they are subject to its change control — a dashboard that could
     * take them would be an unaudited path to production change.
     */
    app = await boot();
    const paths = listRoutePaths(app);

    for (const forbidden of ['restart', 'drain', 'failover', 'scale', 'rollback', 'deploy']) {
      expect(paths.some((path) => path.includes(forbidden))).toBe(false);
    }
  });

  it('has no route that deletes or edits a timeline entry', async () => {
    // An editable timeline is a timeline that gets tidied before the review, and the details that
    // get tidied away are the ones a postmortem exists to find.
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths.filter((path) => path.startsWith('DELETE '))).toEqual([]);
    expect(paths.some((path) => path.startsWith('PUT ') || path.startsWith('PATCH '))).toBe(false);
  });

  it('maps the dashboard, services, objectives and incidents', async () => {
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths).toContain('GET /sre/dashboard');
    expect(paths).toContain('GET /sre/services');
    expect(paths).toContain('GET /sre/slo');
    expect(paths).toContain('GET /sre/incidents');
  });
});

describe('nothing reports healthy by default', () => {
  it('reports an objective with no measurements as insufficient data, not as met', async () => {
    /*
     * The rule that matters most on a dashboard. A green square meaning "we have not looked" is
     * worse than no square, because it is read at speed by somebody deciding whether to escalate.
     */
    app = await boot();
    const controller = app.get(OperationsController);
    const result = controller.objectives() as {
      objectives: Array<{ verdict: string; reason: string }>;
    };

    expect(result.objectives[0]?.verdict).toBe('insufficient_data');
    expect(result.objectives[0]?.reason).toContain('No measurements');
  });

  it('reports an unprobed dependency as unknown rather than as fine', async () => {
    app = await boot();
    const controller = app.get(OperationsController);
    const dashboard = controller.dashboard() as {
      services: Array<{ state: string }>;
      unobserved: unknown[];
    };

    expect(dashboard.services[0]?.state).toBe('UNKNOWN');
    expect(dashboard.unobserved).toHaveLength(1);
  });

  it('judges an objective once there is enough traffic behind it', async () => {
    app = await boot(
      state({
        measurements: [
          sliMeasurementSchema.parse({
            sliId: 'payments.api.availability',
            windowStart: '2026-06-01T00:00:00.000Z',
            windowEnd: '2026-06-01T01:00:00.000Z',
            goodEvents: 99_950,
            validEvents: 100_000,
          }),
        ],
      }),
    );

    const result = app.get(OperationsController).objectives() as {
      objectives: Array<{ verdict: string; budget: { state: string } | null }>;
    };

    expect(result.objectives[0]?.verdict).toBe('met');
    expect(result.objectives[0]?.budget?.state).toBe('healthy');
  });
});

describe('segregation of duties', () => {
  it('separates running an experiment from approving one', () => {
    // A role holding both can inject faults into production alone.
    expect(SEGREGATED_PAIRS).toEqual([
      [SRE_PERMISSIONS.EXPERIMENT_RUN.key, SRE_PERMISSIONS.EXPERIMENT_APPROVE.key],
    ]);
  });

  it('keeps closing an incident distinct from updating one', () => {
    /*
     * Closing asserts the incident is over and, for a SEV1 or SEV2, that a postmortem exists. It
     * is the assertion rather than the mechanics that wants a second person.
     */
    expect(SRE_PERMISSIONS.INCIDENT_CLOSE.key).not.toBe(SRE_PERMISSIONS.INCIDENT_UPDATE.key);
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
