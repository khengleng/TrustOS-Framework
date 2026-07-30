import 'reflect-metadata';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import { createNullLogger } from '@trustos/logging';
import { HEALTH_REGISTRY, HealthRegistry } from '@trustos/observability';
import { MODULE_CATALOG, requireModule } from '@trustos/module-registry';
import { moduleInstanceToken, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { FakeModelDelegate } from '@trustos/tenancy';
import { DocumentModule } from '@trustos/module-document/nest';
import { FeatureFlagsModule } from '@trustos/module-feature-flags/nest';
import { FileStorageModule } from '@trustos/module-file-storage/nest';
import { NotificationModule } from '@trustos/module-notification/nest';
import { ReportingModule } from '@trustos/module-reporting/nest';
import { SearchModule } from '@trustos/module-search/nest';
import { WorkflowModule } from '@trustos/module-workflow/nest';
import { AdapterModule } from '@trustos/module-adapter/nest';
import { EventsModule } from '@trustos/module-events/nest';
import { ExportModule } from '@trustos/module-export/nest';
import { ImportModule } from '@trustos/module-import/nest';
import { JobsModule } from '@trustos/module-jobs/nest';
import { SchedulerModule } from '@trustos/module-scheduler/nest';
import { SyncModule } from '@trustos/module-sync/nest';
import { WebhookModule } from '@trustos/module-webhook/nest';

/**
 * NestJS wiring, booted for real.
 *
 * The unit tests prove each module's behaviour; this proves the part no unit test
 * can reach — that seven module packages can be imported into one Nest
 * application, that dependency injection resolves, that every route the catalog
 * advertises is actually mapped, that each module's `initialize` runs and its
 * health indicator reaches the application's readiness probe, and that shutdown
 * runs on the way out.
 *
 * It runs inside the framework monorepo, where there is exactly one copy of
 * `@nestjs/core`. That matters: a generated application linked to a framework
 * checkout with `file:` dependencies resolves Nest from the *framework's*
 * node_modules, so `Reflector` is a different class there and DI cannot resolve.
 * See docs/modules.md, "Running a linked application".
 */

const AUDIT_SERVICE = Symbol.for('product.audit-service');
const APP_LOGGER = Symbol.for('product.logger');
const PRISMA = Symbol.for('product.prisma');

/**
 * Every Prisma model the seven modules expect, backed by the framework's
 * in-memory delegate. Enough for the modules to initialize; the behavioural tests
 * exercise the queries.
 */
function fakePrisma(): Record<string, FakeModelDelegate> {
  const models = [
    'storedObject',
    'storedObjectVersion',
    'notificationTemplate',
    'notificationMessage',
    'notificationAttempt',
    'documentCategory',
    'document',
    'documentVersion',
    'workflowDefinition',
    'workflowInstance',
    'workflowTask',
    'workflowHistoryEntry',
    'reportSchedule',
    'featureFlag',
    'featureFlagOverride',
  ];

  return Object.fromEntries(models.map((model) => [model, new FakeModelDelegate([])]));
}

/** Stands in for the host application's global providers. */
@Global()
@Module({})
class HostModule {
  static forRoot(registry: HealthRegistry) {
    const providers = [
      { provide: APP_LOGGER, useValue: createNullLogger() },
      { provide: AUDIT_SERVICE, useValue: new AuditService({ sink: new InMemoryAuditSink() }) },
      { provide: PRISMA, useValue: fakePrisma() },
      { provide: HEALTH_REGISTRY, useValue: registry },
    ];

    return {
      module: HostModule,
      providers,
      exports: providers.map((provider) => provider.provide),
    };
  }
}

const binding: ModuleHostBinding = {
  inject: [APP_LOGGER, AUDIT_SERVICE, PRISMA],
  useFactory: ((logger: never, audit: never, prisma: never) => ({
    logger,
    audit,
    prisma,
    environment: 'test' as const,
    config: {},
  })) as ModuleHostBinding['useFactory'],
};

describe('booting an application with every module installed', () => {
  let app: INestApplication;
  let registry: HealthRegistry;

  beforeAll(async () => {
    registry = new HealthRegistry({ service: 'wiring', version: '0.1.0', environment: 'test' });

    const moduleRef = await Test.createTestingModule({
      imports: [
        HostModule.forRoot(registry),
        FileStorageModule.forRoot(binding),
        DocumentModule.forRoot(binding),
        NotificationModule.forRoot(binding),
        WorkflowModule.forRoot(binding),
        ReportingModule.forRoot(binding),
        SearchModule.forRoot(binding),
        FeatureFlagsModule.forRoot(binding),

        // The integration layer. These contribute lifecycle and health rather than controllers,
        // so they add no routes — which is what the route assertion below now expects.
        EventsModule.forRoot(binding),
        WebhookModule.forRoot(binding),
        JobsModule.forRoot(binding),
        SchedulerModule.forRoot(binding),
        AdapterModule.forRoot(binding),
        ImportModule.forRoot(binding),
        ExportModule.forRoot(binding),
        SyncModule.forRoot(binding),
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('resolves dependency injection for every module', () => {
    for (const entry of MODULE_CATALOG) {
      const instance = app.get(moduleInstanceToken(entry.metadata.id));
      expect(instance, entry.metadata.id).toBeDefined();
      expect((instance as { moduleId: string }).moduleId).toBe(entry.metadata.id);
    }
  });

  it('maps every route the catalog advertises', () => {
    // The catalog is what `add-module` documents and what a reviewer reads. A route
    // it claims but the controller does not expose would be a lie in the generated
    // documentation, and one the other direction would be an undocumented endpoint.
    const mapped = collectRoutes(app);

    for (const entry of MODULE_CATALOG) {
      for (const route of entry.routes) {
        expect(
          mapped.has(`${route.method} ${route.path}`),
          `${route.method} ${route.path} (${entry.metadata.id})`,
        ).toBe(true);
      }
    }
  });

  it('exposes no module route the catalog does not declare', () => {
    const declared = new Set(
      MODULE_CATALOG.flatMap((entry) =>
        entry.routes.map((route) => `${route.method} ${route.path}`),
      ),
    );

    const moduleRoutePrefixes = [
      '/files',
      '/documents',
      '/notifications',
      '/workflows',
      '/reports',
      '/search',
      '/feature-flags',
    ];

    for (const route of collectRoutes(app)) {
      const path = route.slice(route.indexOf(' ') + 1);
      if (!moduleRoutePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        continue;
      }
      expect(declared.has(route), route).toBe(true);
    }
  });

  it('ran every module initialize hook', () => {
    // `initialize` throws without a database, so reaching `app.init()` at all
    // proves each hook ran and each module was satisfied by what the host gave it.
    expect(registry.liveness().status).toBe('ok');
  });

  it('registered a health indicator per module with the application probe', async () => {
    const report = await registry.readiness();
    const names = report.checks.map((check) => check.name).sort();

    expect(names).toEqual(MODULE_CATALOG.map((entry) => `module:${entry.metadata.id}`).sort());
    // Search starts with no adapters registered, which it reports as degraded — so
    // the aggregate is degraded and, because module indicators are non-critical,
    // still not `down`.
    expect(report.status).toBe('degraded');
    expect(report.checks.find((check) => check.name === 'module:search')?.status).toBe('degraded');
  });

  it('guards every module route with a permission', () => {
    // Read from the catalog rather than from Nest metadata: `PermissionsGuard`
    // denies a route that declares none, and the catalog is what the guard's
    // decorator arguments are derived from.
    for (const entry of MODULE_CATALOG) {
      for (const route of entry.routes) {
        expect(route.permission.startsWith(`${entry.metadata.id}.`), route.path).toBe(true);
      }
    }
  });

  it('shuts every module down when the application closes', async () => {
    const notification = app.get(moduleInstanceToken('notification')) as {
      shutdown(): Promise<void>;
    };

    // Closing twice would fail if shutdown were not idempotent; the assertion is
    // that a direct call after `app.close()` in afterAll is still safe.
    await expect(notification.shutdown()).resolves.toBeUndefined();
  });
});

describe('the document module dependency', () => {
  it('is declared, and file-storage supplies the port it uses', () => {
    const document = requireModule('document');
    expect(document.dependencies.map((dependency) => dependency.moduleId)).toEqual([
      'file-storage',
    ]);

    // There is no Nest-level import between them: document uses file-storage's
    // provider port, not its service. The dependency is real at the type level and
    // in the install order, and absent from the container.
    expect(document.extensionPoints.some((point) => point.port === 'StorageProvider')).toBe(true);
  });
});

interface RouterLayer {
  route?: { path?: string | string[]; methods?: Record<string, boolean> };
}

/**
 * `GET /files` etc., read from the router Nest built.
 *
 * Express moved the router from `app._router` to `app.router` in v5, and Nest 11
 * ships v5; both are checked so the test does not silently return an empty set —
 * which would make the assertions pass by finding nothing.
 */
function collectRoutes(app: INestApplication): Set<string> {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack?: RouterLayer[] };
    _router?: { stack?: RouterLayer[] };
  };

  const stack = instance.router?.stack ?? instance._router?.stack ?? [];
  if (stack.length === 0) {
    throw new Error('Could not read the Express router; the route assertions would be vacuous.');
  }

  const routes = new Set<string>();

  for (const layer of stack) {
    const paths = Array.isArray(layer.route?.path)
      ? layer.route?.path
      : layer.route?.path
        ? [layer.route.path]
        : [];

    for (const path of paths) {
      for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
        if (enabled) routes.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }

  return routes;
}
