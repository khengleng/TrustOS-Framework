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
import { ApiCatalog, apiDefinitionSchema } from '@trustsystem/api-catalog';
import { ConsumerRegistry, consumerSchema } from '@trustsystem/api-consumer';
import type { ActorContext } from '@trustsystem/shared-types';
import { ApiDeveloperPortalModule } from './api-developer-portal.module';
import { API_CATALOG, CONSUMER_REGISTRY, GUARD_ORDER, PORTAL_STATE } from './tokens';
import { PortalController, type PortalState } from './controllers/portal.controller';
import { PORTAL_PERMISSIONS, SEGREGATED_PAIRS } from './permissions';

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

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'listMerchants',
    method: 'GET',
    path: '/api/merchants',
    summary: 'Lists the merchants in the calling organization.',
    scopes: ['merchants:read'],
    classification: 'PUBLIC',
    idempotent: true,
    ...overrides,
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return apiDefinitionSchema.parse({
    apiId: 'merchant.api',
    name: 'Merchant API',
    description: 'Registration, verification and profile management for merchants.',
    version: '1.0.0',
    domain: 'merchant',
    environment: 'production',
    lifecycle: 'PUBLISHED',
    businessOwnerId: 'usr_business',
    technicalOwnerId: 'usr_tech',
    authentication: 'api_key',
    scopes: ['merchants:read'],
    operations: [operation()],
    openApiRef: 'specs/merchant-api.yaml',
    serviceId: 'merchant.api',
    sloId: 'merchant.api.availability',
    approvedBy: 'usr_governance',
    approvedAt: '2026-02-01T00:00:00.000Z',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

const ledgerApi = api({
  apiId: 'ledger.api',
  name: 'Ledger API',
  description: 'Reads journal entries and account balances for a merchant.',
  operations: [
    operation({
      operationId: 'listEntries',
      path: '/api/ledger',
      classification: 'HIGHLY_RESTRICTED',
    }),
  ],
});

const consumer = consumerSchema.parse({
  consumerId: 'con_partner_a',
  name: 'Partner A',
  kind: 'partner',
  description: 'An onboarding partner that reconciles merchant records against its own system.',
  organizationId: 'org_platform',
  environment: 'production',
  entitlements: [
    {
      apiId: 'merchant.api',
      majorVersion: 1,
      scopes: ['merchants:read'],
      grantedBy: 'usr_governance',
      grantedAt: '2026-01-15T00:00:00.000Z',
      expiresAt: '2027-01-15T00:00:00.000Z',
      justification:
        'The partner reconciles merchant records against their own onboarding system nightly.',
    },
  ],
  credentialIds: ['tos_live_abcdef1234'],
  status: 'active',
  ownerId: 'usr_partnerships',
  technicalContact: 'integrations@partner-a.example',
  createdAt: '2026-01-15T00:00:00.000Z',
});

async function boot(state?: PortalState): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ApiDeveloperPortalModule.forRoot({
        config,
        policy,
        logger: createLogger(config),
        overrides: {
          securityEventSinks: [new InMemorySecurityEventSink()],
          auditService: new AuditService({ sink: new InMemoryAuditSink() }),
          apiCatalog: new ApiCatalog([api(), ledgerApi]),
          consumers: new ConsumerRegistry([consumer]),
          ...(state ? { state } : {}),
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

/** A signed-in developer with no consumer of their own. */
const anonymousDeveloper = {
  userId: 'usr_dev',
  email: 'dev@example.com',
} as unknown as ActorContext;
/** The partner's technical contact, which is how the controller resolves their consumer. */
const partner = {
  userId: 'usr_partner',
  email: 'integrations@partner-a.example',
} as unknown as ActorContext;

describe('booting the portal', () => {
  it('resolves the catalog and consumer registry', async () => {
    app = await boot();

    expect(app.get(API_CATALOG)).toBeTruthy();
    expect(app.get(CONSUMER_REGISTRY)).toBeTruthy();
    expect(app.get(PORTAL_STATE)).toBeTruthy();
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

describe('the catalog a viewer sees', () => {
  it('shows a public API to a developer with no entitlements', async () => {
    app = await boot();
    const result = app.get(PortalController).apis(anonymousDeveloper) as {
      apis: Array<{ apiId: string }>;
    };

    expect(result.apis.map((entry) => entry.apiId)).toEqual(['merchant.api']);
  });

  it('does not admit that a restricted API exists', async () => {
    /*
     * Not a greyed-out row saying "contact us for access to the Ledger API". That row is most of
     * the reconnaissance an attacker wanted, served by the documentation site.
     */
    app = await boot();
    const result = app.get(PortalController).apis(anonymousDeveloper) as {
      apis: Array<{ apiId: string }>;
    };

    expect(result.apis.some((entry) => entry.apiId === 'ledger.api')).toBe(false);
  });

  it('answers 404 rather than 403 for an API the viewer may not know about', async () => {
    // A 403 confirms the API is real, which is the fact the visibility rule exists to withhold.
    app = await boot();

    expect(() => app?.get(PortalController).api(anonymousDeveloper, 'ledger.api', '1.0.0')).toThrow(
      /No such API/,
    );
  });

  it('withholds the specification from a viewer who is not entitled', async () => {
    /*
     * An OpenAPI document names fields, error codes and business rules. Listing is a weaker
     * disclosure than documenting, and the two are decided separately.
     */
    app = await boot();
    const internalApi = new ApiCatalog([
      api({ operations: [operation({ classification: 'INTERNAL' })] }),
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ApiDeveloperPortalModule.forRoot({
          config,
          policy,
          logger: createLogger(config),
          overrides: {
            securityEventSinks: [new InMemorySecurityEventSink()],
            auditService: new AuditService({ sink: new InMemoryAuditSink() }),
            apiCatalog: internalApi,
            consumers: new ConsumerRegistry(),
          },
        }),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(stubPrisma())
      .compile();

    const scoped = moduleRef.createNestApplication({ logger: false });
    await scoped.init();

    const result = scoped
      .get(PortalController)
      .api(anonymousDeveloper, 'merchant.api', '1.0.0') as {
      openApiRef: string | null;
      operations: unknown | null;
    };

    expect(result.openApiRef).toBeNull();
    expect(result.operations).toBeNull();
    await scoped.close();
  });
});

describe('credentials', () => {
  it('never returns a key', async () => {
    /*
     * @trustsystem/api-keys hashes on creation, so the value cannot be recovered. This is where
     * somebody would add a "show key" button, so the correct answer is one call away.
     */
    app = await boot();
    const result = app.get(PortalController).credentials(partner) as {
      credentials: Array<{ credentialId: string; display: string; note: string }>;
    };

    expect(result.credentials[0]?.note).toContain('not stored');
    // The prefix comes from the key store, never from slicing the reference — see the comment in
    // the controller. With no key store wired, the portal says so rather than inventing one.
    expect(result.credentials[0]?.display).toBe('unavailable…');
  });

  it('shows a developer with no consumer no credentials at all', async () => {
    app = await boot();
    const result = app.get(PortalController).credentials(anonymousDeveloper) as {
      credentials: unknown[];
    };

    expect(result.credentials).toEqual([]);
  });
});

describe('the shape of the surface', () => {
  it('has no route that issues a production credential', async () => {
    // Self-service ends at the sandbox boundary. Production access is a request, decided by a
    // named person, which creates a consumer through the registry.
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths.some((path) => path.includes('credentials') && path.startsWith('POST '))).toBe(
      false,
    );
    expect(paths).toContain('POST /portal/access-requests');
  });

  it('has no route that publishes an API or edits a consumer', async () => {
    /*
     * The portal is not a second, weaker administration surface for the thing it documents.
     * Publishing lives in the governance console, behind its own permission and its own
     * self-approval refusal.
     */
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths.some((path) => path.includes('publish'))).toBe(false);
    expect(paths.some((path) => path.startsWith('PUT ') || path.startsWith('PATCH '))).toBe(false);
  });

  it('has no route that deletes anything', async () => {
    app = await boot();
    expect(listRoutePaths(app).filter((path) => path.startsWith('DELETE '))).toEqual([]);
  });

  it('resolves the viewer from the actor, never from a parameter', async () => {
    /*
     * A `consumerId` query parameter would let any signed-in developer read any other consumer's
     * entitlements, usage and documentation — the classic IDOR, on the surface most exposed to the
     * internet.
     */
    app = await boot();
    const paths = listRoutePaths(app);

    expect(paths).toContain('GET /portal/usage');
    expect(paths.some((path) => path.includes(':consumerId'))).toBe(false);
  });
});

describe('segregation of duties', () => {
  it('separates requesting access from approving it', () => {
    expect(SEGREGATED_PAIRS).toEqual([
      [PORTAL_PERMISSIONS.REQUEST_ACCESS.key, PORTAL_PERMISSIONS.APPROVE_ACCESS.key],
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
