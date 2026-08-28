import { satisfiesMinimum, satisfiesVersionRange } from '@trustos/module-sdk';
import { ModuleRegistryError } from './errors';
import type { ModuleCatalogEntry } from './schema';

/**
 * Dependency resolution over the module graph.
 *
 * Order matters twice: at install time, because a module's Prisma fragment may
 * reference a table another module owns, and at start-up, because
 * `initialize()` runs in dependency order and `shutdown()` in reverse. Getting
 * either backwards produces a failure that looks like a bug in the dependent
 * module rather than a bug in the ordering.
 */

/**
 * The minimum a node needs for ordering.
 *
 * Deliberately not `ModuleCatalogEntry`: the same ordering is needed at
 * start-up over live `TrustosModule` instances, and one implementation of a
 * graph walk is better than two that can disagree about what a cycle is.
 */
export interface DependencyNode {
  id: string;
  dependencies: Array<{ moduleId: string }>;
}

/** Dependency-first order over `nodes`, by id. Throws on a cycle. */
export function topologicalIds(nodes: DependencyNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  /**
   * Depth-first with an explicit `visiting` mark.
   *
   * The mark is what distinguishes "already emitted" from "currently on the
   * stack": a diamond (two modules depending on a third) is legal and hits
   * `done`, while a cycle hits `visiting` and is an error. Counting visits
   * instead would reject the diamond.
   */
  const visit = (id: string, path: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw new ModuleRegistryError(
        'dependency_cycle',
        `Module dependency cycle: ${[...path, id].join(' -> ')}.`,
        'Break the cycle by extracting the shared part into a third module.',
      );
    }

    const node = byId.get(id);
    // Missing dependencies are reported by the callers that know whether the
    // dependency was optional. Skipping here keeps this function about ordering.
    if (!node) return;

    state.set(id, 'visiting');
    for (const dependency of node.dependencies) {
      visit(dependency.moduleId, [...path, id]);
    }
    state.set(id, 'done');
    ordered.push(id);
  };

  // Sorted so the output is deterministic when the graph does not constrain it.
  for (const node of [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    visit(node.id, []);
  }

  return ordered;
}

/** Dependency-first order over catalog entries. */
export function topologicalOrder(entries: ModuleCatalogEntry[]): ModuleCatalogEntry[] {
  const byId = new Map(entries.map((entry) => [entry.metadata.id, entry]));

  return topologicalIds(
    entries.map((entry) => ({ id: entry.metadata.id, dependencies: entry.dependencies })),
  ).flatMap((id) => {
    const entry = byId.get(id);
    return entry ? [entry] : [];
  });
}

/** Throws when the graph contains a cycle. Used when the catalog loads. */
export function assertNoCycles(entries: ModuleCatalogEntry[]): void {
  topologicalOrder(entries);
}

export interface ResolveOptions {
  /** Framework version of the target application, for compatibility checks. */
  frameworkVersion?: string;
  /** Modules already installed. Their dependencies count as satisfied. */
  installed?: string[];
  /** Include optional dependencies in the closure. Off by default. */
  includeOptional?: boolean;
}

export interface ResolvedInstall {
  /** Everything to install, dependencies first. */
  order: ModuleCatalogEntry[];
  /** Modules pulled in because something asked for depended on them. */
  addedForDependencies: string[];
  /** Already-installed modules that were requested again. */
  alreadyInstalled: string[];
  /** Optional dependencies that were not installed. Informational. */
  skippedOptional: string[];
}

/**
 * Expands `requested` into the full set to install, dependencies first.
 *
 * A dependency that is already installed satisfies the requirement without
 * being reinstalled — which is what makes `add-module` idempotent, and what
 * lets `document` be installed twice without disturbing `file-storage`.
 */
export function resolveInstallOrder(
  catalog: ModuleCatalogEntry[],
  requested: string[],
  options: ResolveOptions = {},
): ResolvedInstall {
  const byId = new Map(catalog.map((entry) => [entry.metadata.id, entry]));
  const installed = new Set(options.installed ?? []);
  const includeOptional = options.includeOptional ?? false;

  const alreadyInstalled: string[] = [];
  const skippedOptional: string[] = [];
  const needed = new Map<string, ModuleCatalogEntry>();
  const addedForDependencies = new Set<string>();

  const require = (id: string, requestedBy: string | null): void => {
    const entry = byId.get(id);
    if (!entry) {
      throw new ModuleRegistryError(
        requestedBy ? 'dependency_missing' : 'module_not_found',
        requestedBy
          ? `Module "${requestedBy}" depends on "${id}", which is not in the catalog.`
          : `Unknown module "${id}".`,
        `Known modules: ${catalog.map((item) => item.metadata.id).join(', ')}.`,
      );
    }

    if (options.frameworkVersion) {
      assertFrameworkCompatible(entry, options.frameworkVersion);
    }

    if (needed.has(id)) return;
    if (installed.has(id)) {
      if (requestedBy === null) alreadyInstalled.push(id);
      return;
    }

    needed.set(id, entry);
    if (requestedBy !== null) addedForDependencies.add(id);

    for (const dependency of entry.dependencies) {
      if (dependency.optional && !includeOptional) {
        if (!installed.has(dependency.moduleId)) skippedOptional.push(dependency.moduleId);
        continue;
      }
      assertDependencyVersion(entry, dependency, byId.get(dependency.moduleId));
      require(dependency.moduleId, id);
    }
  };

  for (const id of requested) require(id, null);

  return {
    order: topologicalOrder([...needed.values()]),
    addedForDependencies: [...addedForDependencies].sort(),
    alreadyInstalled,
    skippedOptional: [...new Set(skippedOptional)].sort(),
  };
}

/** Throws when a module needs a newer framework than the application has. */
export function assertFrameworkCompatible(
  entry: ModuleCatalogEntry,
  frameworkVersion: string,
): void {
  if (satisfiesMinimum(frameworkVersion, entry.metadata.minimumFrameworkVersion)) return;

  throw new ModuleRegistryError(
    'version_conflict',
    `Module "${entry.metadata.id}" needs framework ${entry.metadata.minimumFrameworkVersion} or newer, but this application records ${frameworkVersion}.`,
    'Upgrade the framework packages in the application before installing this module.',
  );
}

function assertDependencyVersion(
  entry: ModuleCatalogEntry,
  dependency: { moduleId: string; versionRange: string },
  target: ModuleCatalogEntry | undefined,
): void {
  if (!target) return;
  if (satisfiesVersionRange(target.metadata.version, dependency.versionRange)) return;

  throw new ModuleRegistryError(
    'version_conflict',
    `Module "${entry.metadata.id}" needs "${dependency.moduleId}" ${dependency.versionRange}, but the catalog has ${target.metadata.version}.`,
  );
}
