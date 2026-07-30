import { describe, expect, it } from 'vitest';
import { createTestModuleContext, type TrustosModule } from '@trustos/module-sdk';
import {
  MODULE_CATALOG,
  ModuleRegistry,
  moduleIds,
  requireModule,
  resolveInstallOrder,
} from '@trustos/module-registry';
import { documentModule } from '@trustos/module-document';
import { featureFlagsModule } from '@trustos/module-feature-flags';
import { fileStorageModule } from '@trustos/module-file-storage';
import { notificationModule } from '@trustos/module-notification';
import { reportingModule } from '@trustos/module-reporting';
import { searchModule } from '@trustos/module-search';
import { workflowModule } from '@trustos/module-workflow';

/**
 * Module registration, validated across the whole set.
 *
 * This file is the one place that imports every module package, which is exactly
 * what makes it useful: the per-module tests prove each module in isolation, and
 * this proves the seven of them can be registered into one application without
 * colliding on a route, a permission, a table or a start-up order.
 *
 * It lives beside the modules rather than inside any of them, so no module package
 * has to depend on its six siblings to be tested.
 */

const ALL: TrustosModule[] = [
  documentModule as TrustosModule,
  featureFlagsModule as TrustosModule,
  fileStorageModule as TrustosModule,
  notificationModule as TrustosModule,
  reportingModule as TrustosModule,
  searchModule as TrustosModule,
  workflowModule as TrustosModule,
];

describe('every module', () => {
  it('is defined, valid and tenant-scoped', () => {
    // `defineModule` throws at import time, so reaching this line already proves
    // seven valid definitions. The assertion states the invariant anyway.
    expect(ALL).toHaveLength(moduleIds().length);
    for (const module of ALL) expect(module.tenantScoped, module.metadata.id).toBe(true);
  });

  it('matches its catalog entry exactly', () => {
    for (const module of ALL) {
      const entry = requireModule(module.metadata.id);

      // Declarations come from the catalog through `moduleDeclarations`, so a
      // mismatch means someone hand-edited a module's declarations — which is the
      // drift this test exists to catch.
      expect(module.metadata, module.metadata.id).toEqual(entry.metadata);
      expect(module.permissions).toEqual(entry.permissions);
      expect(module.routes).toEqual(entry.routes);
      expect(module.auditEvents).toEqual(entry.auditEvents);
      expect(module.migrations).toEqual(entry.migrations);
      expect(module.featureFlags).toEqual(entry.featureFlags);
      expect(module.environment).toEqual(entry.environment);
      expect(module.dependencies).toEqual(entry.dependencies);
    }
  });

  it('accepts an empty configuration, so it installs with safe defaults', () => {
    for (const module of ALL) {
      const parsed = module.configSchema.safeParse({});
      expect(parsed.success, module.metadata.id).toBe(true);
    }
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    for (const module of ALL) {
      // A typo in a deployment's configuration must fail loudly, not silently
      // leave the default in place.
      const parsed = module.configSchema.safeParse({ definitelyNotAKey: true });
      expect(parsed.success, module.metadata.id).toBe(false);
    }
  });

  it('declares a permission for every route', () => {
    for (const module of ALL) {
      const declared = new Set(module.permissions.map((permission) => permission.key));
      for (const route of module.routes) {
        expect(declared.has(route.permission), `${module.metadata.id} ${route.path}`).toBe(true);
      }
    }
  });

  it('can be created and produces a health indicator', () => {
    for (const module of ALL) {
      const { context } = createTestModuleContext(module);
      const instance = module.create(context);

      expect(instance.moduleId).toBe(module.metadata.id);
      expect(instance.healthIndicator().name).toBe(`module:${module.metadata.id}`);
      // Module indicators are non-critical: one degraded capability must not take
      // an instance out of rotation.
      expect(instance.healthIndicator().critical).toBe(false);
    }
  });

  it('shuts down cleanly whether or not it was started', async () => {
    for (const module of ALL) {
      const { context } = createTestModuleContext(module);
      await expect(module.create(context).shutdown()).resolves.toBeUndefined();
    }
  });
});

describe('registering all seven into one application', () => {
  const buildRegistry = (): ModuleRegistry => {
    const registry = new ModuleRegistry();
    for (const module of ALL) {
      const { context } = createTestModuleContext(module);
      registry.register(module, module.create(context));
    }
    return registry;
  };

  it('registers without a permission, route or id collision', () => {
    const registry = buildRegistry();
    expect(registry.list()).toHaveLength(7);

    const permissions = registry.permissions().map((permission) => permission.key);
    expect(new Set(permissions).size).toBe(permissions.length);

    const routes = registry.routes().map((route) => `${route.method} ${route.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('orders start-up with file-storage ahead of document', () => {
    const order = buildRegistry()
      .dependencyOrder()
      .map((module) => module.metadata.id);

    expect(order.indexOf('file-storage')).toBeLessThan(order.indexOf('document'));
  });

  it('reports one health indicator per module', () => {
    expect(buildRegistry().healthIndicators()).toHaveLength(7);
  });

  it('aggregates a permission catalog an application can seed from', () => {
    const registry = buildRegistry();
    const keys = registry.permissions().map((permission) => permission.key);

    // Every key is namespaced by its module, which is what stops one role grant
    // opening two modules' doors.
    for (const key of keys) {
      expect(
        moduleIds().some((id) => key.startsWith(`${id}.`)),
        key,
      ).toBe(true);
    }
    expect(keys.length).toBeGreaterThan(25);
  });

  it('claims a distinct Prisma fragment per module', () => {
    const fragments = buildRegistry()
      .migrations()
      .map((migration) => migration.schemaFragment);
    expect(new Set(fragments).size).toBe(fragments.length);

    // Search owns no tables, so six of the seven contribute a fragment.
    expect(fragments).toHaveLength(6);
  });

  it('claims a distinct environment variable per module', () => {
    const names = buildRegistry()
      .environmentVariables()
      .map((variable) => variable.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('installing all seven', () => {
  it('resolves an order that satisfies every dependency', () => {
    const resolved = resolveInstallOrder(MODULE_CATALOG, moduleIds(), {
      frameworkVersion: '0.1.0',
    });

    const positions = new Map(
      resolved.order.map((entry, index) => [entry.metadata.id, index] as const),
    );

    for (const entry of resolved.order) {
      for (const dependency of entry.dependencies) {
        const dependencyPosition = positions.get(dependency.moduleId);
        expect(dependencyPosition, `${entry.metadata.id} -> ${dependency.moduleId}`).toBeLessThan(
          positions.get(entry.metadata.id) as number,
        );
      }
    }

    expect(resolved.order).toHaveLength(7);
  });

  it('is idempotent when everything is already installed', () => {
    const resolved = resolveInstallOrder(MODULE_CATALOG, moduleIds(), {
      installed: moduleIds(),
    });

    expect(resolved.order).toEqual([]);
    expect(resolved.alreadyInstalled).toHaveLength(7);
  });
});
