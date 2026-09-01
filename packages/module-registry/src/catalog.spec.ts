import { describe, expect, it } from 'vitest';
import { environmentPrefix } from '@trustsystem/module-sdk';
import { MODULE_CATALOG, assertCatalogConsistency } from './catalog';
import { BUILT_IN_MODULE_IDS } from './schema';
import {
  listModules,
  moduleDeclarations,
  moduleIds,
  requireModule,
  suggestedPermissionsForRole,
} from './declarations';

/**
 * The catalog is validated when this module is imported, so simply importing it
 * proves it parses. What is asserted below is everything the schema cannot see
 * on its own: that the catalog matches the module packages on disk, and that the
 * conventions hold across all seven entries at once.
 */

describe('MODULE_CATALOG', () => {
  it('contains exactly the built-in modules', () => {
    expect([...moduleIds()].sort()).toEqual([...BUILT_IN_MODULE_IDS].sort());
  });

  it('namespaces every permission, audit action and flag under the module id', () => {
    for (const entry of MODULE_CATALOG) {
      const id = entry.metadata.id;

      for (const permission of entry.permissions) {
        expect(permission.key.startsWith(`${id}.`), permission.key).toBe(true);
      }
      for (const event of entry.auditEvents) {
        expect(event.action.startsWith(`${id}.`), event.action).toBe(true);
      }
      for (const flag of entry.featureFlags) {
        expect(flag.key.startsWith(`${id}.`), flag.key).toBe(true);
      }
      for (const variable of entry.environment) {
        expect(variable.name.startsWith(`${environmentPrefix(id)}_`), variable.name).toBe(true);
      }
    }
  });

  it('gives every route a permission the same module declares', () => {
    for (const entry of MODULE_CATALOG) {
      const declared = new Set(entry.permissions.map((permission) => permission.key));
      for (const route of entry.routes) {
        expect(declared.has(route.permission), `${route.method} ${route.path}`).toBe(true);
      }
    }
  });

  /*
   * Modules that deliberately ship no controller.
   *
   * The integration layer contributes services and lifecycle. Its stores are ports the
   * application supplies, so a controller in the module would have nothing to inject — the
   * application builds its own HTTP surface over the service.
   *
   * Enumerated rather than inferred, so adding a capability module with no routes by accident is
   * still caught. A module that serves data and forgot its routes is a bug; these are not.
   */
  const LIBRARY_SHAPED = new Set([
    'ledger',
    'wallet',
    'transactions',
    'settlement',
    'reconciliation',
    'ai',
    'rag',
    'agent',
    'events',
    'webhook',
    'jobs',
    'scheduler',
    'adapter',
    'import',
    'export',
    'sync',
  ]);

  it('has at least one route and one audit event per module', () => {
    // A module with no routes is a library, and a module that changes data
    // without writing history is not shippable in a regulated product.
    for (const entry of MODULE_CATALOG) {
      if (!LIBRARY_SHAPED.has(entry.metadata.id)) {
        expect(entry.routes.length, entry.metadata.id).toBeGreaterThan(0);
      }
      expect(entry.auditEvents.length, entry.metadata.id).toBeGreaterThan(0);
    }
  });

  it('keeps the library-shaped list honest', () => {
    // Both directions: a module listed here must actually declare no routes, and one that
    // declares none must be listed. Otherwise the exemption above quietly becomes a way to skip
    // the check.
    for (const entry of MODULE_CATALOG) {
      expect(entry.routes.length === 0, entry.metadata.id).toBe(
        LIBRARY_SHAPED.has(entry.metadata.id),
      );
    }
  });

  it('declares extension points and out-of-scope items for every module', () => {
    for (const entry of MODULE_CATALOG) {
      expect(entry.extensionPoints.length, entry.metadata.id).toBeGreaterThan(0);
      expect(entry.outOfScope.length, entry.metadata.id).toBeGreaterThan(0);
    }
  });

  it('numbers schema fragments from 20 so they merge after framework and product models', () => {
    for (const entry of MODULE_CATALOG) {
      for (const migration of entry.migrations) {
        expect(migration.schemaFragment).toMatch(/^prisma\/schema\/[2-9]\d-[a-z-]+\.prisma$/);
      }
    }
  });

  it('records the document -> file-storage dependency rather than duplicating storage', () => {
    const document = requireModule('document');
    expect(document.dependencies.map((dependency) => dependency.moduleId)).toEqual([
      'file-storage',
    ]);
  });

  it('keeps search free of tables of its own', () => {
    // Search queries what other modules already store. An index would be a
    // second copy of customer data to keep tenant-correct.
    expect(requireModule('search').migrations).toEqual([]);
  });

  it('exposes declarations ready to spread into defineModule', () => {
    const declarations = moduleDeclarations('notification');
    expect(declarations.metadata.id).toBe('notification');
    expect(declarations.permissions.length).toBeGreaterThan(0);
    expect(Object.keys(declarations).sort()).toEqual([
      'auditEvents',
      'dependencies',
      'environment',
      'extensionPoints',
      'featureFlags',
      'metadata',
      'migrations',
      'permissions',
      'routes',
    ]);
  });

  it('explains itself when asked for a module that does not exist', () => {
    expect(() => requireModule('payments')).toThrowError(/Unknown module "payments"/);
  });

  it('never suggests a module permission for the auditor role that is not read-only', () => {
    // An auditor who can change what they are auditing is not an auditor.
    const suggested = suggestedPermissionsForRole('auditor');
    expect(suggested.length).toBeGreaterThan(0);
    for (const key of suggested) {
      // `search` is read-only by definition, like `read` and `list`. `run` is here for running a
      // report, which reads; `agent.run` deliberately does not suggest the auditor role, because
      // running an agent spends money and can call tools.
      expect(key).toMatch(/\.(read|list|execute|evaluate|run|search)$/);
    }
  });

  it('lists modules in a stable order', () => {
    expect(listModules().map((entry) => entry.metadata.id)).toEqual(moduleIds());
  });
});

describe('assertCatalogConsistency', () => {
  const base = MODULE_CATALOG[0];

  it('rejects two modules claiming the same permission key', () => {
    if (!base) throw new Error('catalog is empty');
    const clone = structuredClone(base);
    clone.metadata.id = 'other';
    clone.packaging.packageName = '@trustsystem/module-other';
    clone.packaging.directory = 'packages/modules/other';

    // The danger is not the duplicate itself: it is that one role grant would
    // then open two modules' doors.
    expect(() => assertCatalogConsistency([base, clone])).toThrowError(
      /is claimed by more than one module/,
    );
  });

  it('rejects a dependency on a module that is not in the catalog', () => {
    if (!base) throw new Error('catalog is empty');
    const clone = structuredClone(base);
    clone.dependencies = [
      { moduleId: 'ghost', versionRange: '^0.1.0', optional: false, reason: 'x' },
    ];

    expect(() => assertCatalogConsistency([clone])).toThrowError(/unknown module "ghost"/);
  });

  it('rejects a dependency cycle', () => {
    if (!base) throw new Error('catalog is empty');
    const left = structuredClone(base);
    const right = structuredClone(base);

    left.metadata.id = 'left';
    left.packaging.packageName = '@trustsystem/module-left';
    left.packaging.directory = 'packages/modules/left';
    left.dependencies = [
      { moduleId: 'right', versionRange: '^0.1.0', optional: false, reason: 'x' },
    ];

    right.metadata.id = 'right';
    right.packaging.packageName = '@trustsystem/module-right';
    right.packaging.directory = 'packages/modules/right';
    right.permissions = [];
    right.routes = [];
    right.migrations = [];
    right.environment = [];
    right.dependencies = [
      { moduleId: 'left', versionRange: '^0.1.0', optional: false, reason: 'x' },
    ];

    expect(() => assertCatalogConsistency([left, right])).toThrowError(/dependency cycle/);
  });
});
