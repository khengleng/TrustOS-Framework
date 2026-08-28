import type {
  HealthIndicator,
  ModuleAuditEvent,
  ModuleEnvVar,
  ModuleFeatureFlag,
  ModuleInstance,
  ModuleMigration,
  ModulePermission,
  ModuleRoute,
  TrustosModule,
} from '@trustos/module-sdk';
import { ModuleRegistryError } from './errors';
import { topologicalIds } from './resolve';

/**
 * The in-memory module registry.
 *
 * One per application. Modules register themselves at start-up and everything
 * else — the permission catalog to seed, the routes to document, the health
 * indicators to attach, the order to start and stop in — is derived from what is
 * registered. An application therefore never keeps a hand-maintained list of
 * "which modules are installed", which is the list that goes stale first.
 *
 * Registration is strict on purpose. Two modules claiming the same permission
 * key or the same route are refused rather than merged: a merged permission is a
 * single grant that opens two doors, and a merged route is whichever controller
 * Nest happened to bind last.
 */

export interface RegisteredModule {
  module: TrustosModule;
  /** Present once the application has created the module. */
  instance: ModuleInstance | null;
}

export interface ModuleSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  stability: string;
  dependencies: string[];
  permissions: number;
  routes: number;
  migrations: number;
  featureFlags: number;
  started: boolean;
}

export class ModuleRegistry {
  private readonly entries = new Map<string, RegisteredModule>();
  private readonly started: string[] = [];

  /**
   * Registers a module, and optionally the instance the application created.
   *
   * The instance is separate because only the application can build a
   * `ModuleContext` — it owns the configuration, the logger and the database
   * client. The registry's job is to know what exists and in what order it runs.
   */
  register(module: TrustosModule, instance: ModuleInstance | null = null): this {
    const id = module.metadata.id;

    if (this.entries.has(id)) {
      throw new ModuleRegistryError(
        'already_registered',
        `Module "${id}" is already registered.`,
        'Register each module once. A module installed twice is a configuration mistake, not a scaling strategy.',
      );
    }

    for (const permission of module.permissions) {
      const owner = this.ownerOfPermission(permission.key);
      if (owner) {
        throw new ModuleRegistryError(
          'already_registered',
          `Permission "${permission.key}" is already claimed by module "${owner}".`,
        );
      }
    }

    for (const route of module.routes) {
      const owner = this.ownerOfRoute(route);
      if (owner) {
        throw new ModuleRegistryError(
          'already_registered',
          `Route ${route.method} ${route.path} is already claimed by module "${owner}".`,
        );
      }
    }

    this.entries.set(id, { module, instance });
    return this;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): RegisteredModule | undefined {
    return this.entries.get(id);
  }

  require(id: string): RegisteredModule {
    const entry = this.entries.get(id);
    if (entry) return entry;

    throw new ModuleRegistryError(
      'module_not_found',
      `Module "${id}" is not registered.`,
      `Registered: ${[...this.entries.keys()].join(', ') || '(none)'}.`,
    );
  }

  list(): TrustosModule[] {
    return [...this.entries.values()].map((entry) => entry.module);
  }

  /** Rows for an operator-facing listing, in dependency order. */
  describe(): ModuleSummary[] {
    return this.dependencyOrder().map((module) => ({
      id: module.metadata.id,
      name: module.metadata.name,
      version: module.metadata.version,
      description: module.metadata.description,
      stability: module.metadata.stability,
      dependencies: module.dependencies.map((dependency) => dependency.moduleId),
      permissions: module.permissions.length,
      routes: module.routes.length,
      migrations: module.migrations.length,
      featureFlags: module.featureFlags.length,
      started: this.started.includes(module.metadata.id),
    }));
  }

  // --- aggregated declarations ---------------------------------------------

  permissions(): ModulePermission[] {
    return this.list().flatMap((module) => module.permissions);
  }

  routes(): ModuleRoute[] {
    return this.list().flatMap((module) => module.routes);
  }

  auditEvents(): ModuleAuditEvent[] {
    return this.list().flatMap((module) => module.auditEvents);
  }

  featureFlags(): ModuleFeatureFlag[] {
    return this.list().flatMap((module) => module.featureFlags);
  }

  migrations(): ModuleMigration[] {
    return this.list().flatMap((module) => module.migrations);
  }

  environmentVariables(): ModuleEnvVar[] {
    return this.list().flatMap((module) => module.environment);
  }

  /** Health indicators for every started module, for the app's HealthRegistry. */
  healthIndicators(): HealthIndicator[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.instance ? [entry.instance.healthIndicator()] : [],
    );
  }

  // --- ordering and lifecycle ----------------------------------------------

  /**
   * Registered modules in dependency order.
   *
   * Throws when a required dependency is not registered: a module whose
   * dependency is missing would fail at its first database call instead of at
   * start-up, and the error would name the wrong module.
   */
  dependencyOrder(): TrustosModule[] {
    this.assertDependenciesSatisfied();

    const byId = new Map(this.entries);
    return topologicalIds(
      this.list().map((module) => ({
        id: module.metadata.id,
        dependencies: module.dependencies.filter((dependency) => !dependency.optional),
      })),
    ).flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry.module] : [];
    });
  }

  assertDependenciesSatisfied(): void {
    const missing: string[] = [];

    for (const { module } of this.entries.values()) {
      for (const dependency of module.dependencies) {
        if (dependency.optional) continue;
        if (this.entries.has(dependency.moduleId)) continue;
        missing.push(
          `"${module.metadata.id}" requires "${dependency.moduleId}" (${dependency.reason})`,
        );
      }
    }

    if (missing.length > 0) {
      throw new ModuleRegistryError(
        'dependency_missing',
        `Unsatisfied module dependencies: ${missing.join('; ')}.`,
        'Install the missing module with `trustos add-module`, or register it at start-up.',
      );
    }
  }

  /**
   * Starts every registered module in dependency order.
   *
   * Start-up is transactional: if one module fails, the ones already started are
   * shut down before the error propagates. A half-started application is worse
   * than one that refuses to start, because it serves traffic against modules
   * whose invariants were never established.
   */
  async initializeAll(): Promise<void> {
    for (const module of this.dependencyOrder()) {
      const entry = this.require(module.metadata.id);
      if (!entry.instance) {
        throw new ModuleRegistryError(
          'lifecycle_failed',
          `Module "${module.metadata.id}" was registered without an instance and cannot be started.`,
        );
      }

      try {
        await entry.instance.initialize();
        this.started.push(module.metadata.id);
      } catch (error) {
        await this.shutdownAll();
        throw new ModuleRegistryError(
          'lifecycle_failed',
          `Module "${module.metadata.id}" failed to initialize: ${messageOf(error)}`,
        );
      }
    }
  }

  /**
   * Stops started modules in reverse dependency order.
   *
   * Errors are collected rather than thrown: a shutdown that stops at the first
   * failure leaks whatever the remaining modules were holding.
   */
  async shutdownAll(): Promise<{
    stopped: string[];
    failures: Array<{ id: string; error: string }>;
  }> {
    const stopped: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];

    for (const id of [...this.started].reverse()) {
      const entry = this.entries.get(id);
      if (!entry?.instance) continue;

      try {
        await entry.instance.shutdown();
        stopped.push(id);
      } catch (error) {
        failures.push({ id, error: messageOf(error) });
      }
    }

    this.started.length = 0;
    return { stopped, failures };
  }

  /** Ids of modules that have been started, in start order. */
  startedModules(): string[] {
    return [...this.started];
  }

  // --- internals ------------------------------------------------------------

  private ownerOfPermission(key: string): string | null {
    for (const { module } of this.entries.values()) {
      if (module.permissions.some((permission) => permission.key === key)) {
        return module.metadata.id;
      }
    }
    return null;
  }

  private ownerOfRoute(route: ModuleRoute): string | null {
    for (const { module } of this.entries.values()) {
      if (
        module.routes.some(
          (candidate) => candidate.method === route.method && candidate.path === route.path,
        )
      ) {
        return module.metadata.id;
      }
    }
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
