import type {
  ModuleAuditEvent,
  ModuleDependency,
  ModuleEnvVar,
  ModuleExtensionPoint,
  ModuleFeatureFlag,
  ModuleMetadata,
  ModuleMigration,
  ModulePermission,
  ModuleRoute,
} from '@trustos/module-sdk';
import { MODULE_CATALOG } from './catalog';
import { ModuleRegistryError } from './errors';
import type { ModuleCatalogEntry } from './schema';

/** Every catalog entry, in catalog order. */
export function listModules(): ModuleCatalogEntry[] {
  return MODULE_CATALOG;
}

export function findModule(id: string): ModuleCatalogEntry | undefined {
  return MODULE_CATALOG.find((entry) => entry.metadata.id === id);
}

export function requireModule(id: string): ModuleCatalogEntry {
  const entry = findModule(id);
  if (entry) return entry;

  throw new ModuleRegistryError(
    'module_not_found',
    `Unknown module "${id}".`,
    `Known modules: ${MODULE_CATALOG.map((item) => item.metadata.id).join(', ')}.`,
  );
}

export function moduleIds(): string[] {
  return MODULE_CATALOG.map((entry) => entry.metadata.id);
}

/**
 * The declarative half of a module definition, ready to spread into
 * `defineModule`.
 *
 * This is how a module package gets its own permissions, routes, audit events
 * and migrations: it reads them from the catalog rather than restating them. The
 * repository therefore contains exactly one declaration of each, and
 * `defineModule` still re-validates what it receives — so a module cannot widen
 * its own surface by editing its source, only by editing the catalog, which is
 * where a reviewer looks.
 */
export interface ModuleDeclarations {
  metadata: ModuleMetadata;
  dependencies: ModuleDependency[];
  permissions: ModulePermission[];
  auditEvents: ModuleAuditEvent[];
  routes: ModuleRoute[];
  migrations: ModuleMigration[];
  featureFlags: ModuleFeatureFlag[];
  environment: ModuleEnvVar[];
  extensionPoints: ModuleExtensionPoint[];
}

export function moduleDeclarations(id: string): ModuleDeclarations {
  const entry = requireModule(id);

  return {
    metadata: entry.metadata,
    dependencies: entry.dependencies,
    permissions: entry.permissions,
    auditEvents: entry.auditEvents,
    routes: entry.routes,
    migrations: entry.migrations,
    featureFlags: entry.featureFlags,
    environment: entry.environment,
    extensionPoints: entry.extensionPoints,
  };
}

/** Permission keys a module introduces. Used by seeds and by the installer. */
export function modulePermissionKeysFor(id: string): string[] {
  return requireModule(id).permissions.map((permission) => permission.key);
}

/**
 * Permission keys a role would receive if the application followed every
 * module's `suggestedRoles`.
 *
 * Advice, not enforcement: `add-module` prints this and the application's seed
 * decides. A module that could grant its own permissions would be a
 * privilege-escalation path in a package.
 */
export function suggestedPermissionsForRole(role: string, ids: string[] = moduleIds()): string[] {
  return ids
    .flatMap((id) => requireModule(id).permissions)
    .filter((permission) => permission.suggestedRoles.includes(role))
    .map((permission) => permission.key)
    .sort();
}
