import { compareVersions, satisfies, isBreakingChange } from '@trustsystem/version-manager';

/**
 * Dependency analysis over the module graph.
 *
 * Six problems, and they fail at different times, which is why they are found together here
 * rather than each by whichever tool happened to notice:
 *
 *   * **Cycles** fail at startup, loudly, and are the easy one.
 *   * **Missing dependencies** fail on the first request that reaches the missing module.
 *   * **Version conflicts** fail when two modules need incompatible versions of a third — and
 *     whichever one loses is decided by install order, so the failure moves between machines.
 *   * **Unused modules** never fail. They sit in a deployment enlarging its attack surface and
 *     its upgrade cost, and nothing ever complains.
 *   * **Breaking changes** fail after an upgrade, in the part of the system nobody changed.
 *   * **Architecture violations** never fail either. They accumulate until a layer cannot be
 *     replaced, and by then the cost of finding out is the cost of a rewrite.
 *
 * Three of the six are invisible at runtime. That is the argument for a static analyzer.
 */

export interface GraphModule {
  id: string;
  version: string;
  dependencies: Array<{ moduleId: string; versionRange: string; optional?: boolean }>;
  /** Modules this one is allowed to depend on. Empty means no restriction. */
  layer?: string;
}

export type FindingKind =
  | 'cycle'
  | 'missing_dependency'
  | 'version_conflict'
  | 'unused_module'
  | 'breaking_change'
  | 'architecture_violation';

export interface AnalysisFinding {
  kind: FindingKind;
  severity: 'error' | 'warning' | 'info';
  /** The module the finding is about. A cycle names its first member. */
  moduleId: string;
  detail: string;
  remediation?: string;
  /** Every module involved, for a cycle or a conflict. */
  involves?: string[];
}

export interface AnalysisReport {
  findings: AnalysisFinding[];
  ok: boolean;
  /** Modules in dependency order. Empty when a cycle makes ordering impossible. */
  installOrder: string[];
}

export interface AnalyzeOptions {
  modules: readonly GraphModule[];
  /** Modules the application actually imports. Anything else is unused. */
  entryPoints?: readonly string[];
  /** Previous versions, for detecting a breaking change across an upgrade. */
  previousVersions?: Readonly<Record<string, string>>;
  /** Which layer may depend on which. See `architecture-validator` for the code-level rules. */
  layerRules?: Readonly<Record<string, readonly string[]>>;
}

export function analyzeDependencies(options: AnalyzeOptions): AnalysisReport {
  const { modules } = options;
  const byId = new Map(modules.map((module) => [module.id, module]));
  const findings: AnalysisFinding[] = [];

  findings.push(...findMissing(modules, byId));

  const cycles = findCycles(modules, byId);
  findings.push(...cycles);

  findings.push(...findVersionConflicts(modules, byId));
  findings.push(...findUnused(modules, byId, options.entryPoints));
  findings.push(...findBreakingChanges(modules, options.previousVersions));
  findings.push(...findLayerViolations(modules, byId, options.layerRules));

  return {
    findings,
    ok: !findings.some((finding) => finding.severity === 'error'),
    installOrder: cycles.length > 0 ? [] : topologicalOrder(modules, byId),
  };
}

// ---------------------------------------------------------------------------

function findMissing(
  modules: readonly GraphModule[],
  byId: Map<string, GraphModule>,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];

  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (byId.has(dependency.moduleId)) continue;

      /*
       * An absent optional dependency is the feature working as designed — the module degrades.
       * Reporting it as an error would make every optional dependency mandatory in practice.
       */
      findings.push({
        kind: 'missing_dependency',
        severity: dependency.optional ? 'info' : 'error',
        moduleId: module.id,
        detail: dependency.optional
          ? `${module.id} can use "${dependency.moduleId}", which is not installed. It will run without it.`
          : `${module.id} needs "${dependency.moduleId}", which is not installed.`,
        remediation: dependency.optional
          ? undefined
          : `Install ${dependency.moduleId}, or remove ${module.id}.`,
        involves: [module.id, dependency.moduleId],
      });
    }
  }

  return findings;
}

/**
 * Cycles, by depth-first search with a recursion stack.
 *
 * Reports the cycle *as a path* rather than as a set. "a → b → c → a" tells a reader which edge
 * to cut; "{a, b, c} form a cycle" makes them draw it themselves.
 */
function findCycles(
  modules: readonly GraphModule[],
  byId: Map<string, GraphModule>,
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const reported = new Set<string>();

  const visit = (id: string): void => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      const path = [...stack.slice(start), id];
      const signature = [...path].sort().join(',');

      if (!reported.has(signature)) {
        reported.add(signature);
        findings.push({
          kind: 'cycle',
          severity: 'error',
          moduleId: path[0] as string,
          detail: `Dependency cycle: ${path.join(' → ')}.`,
          remediation:
            'Break the cycle by extracting the shared piece into a third module, or by inverting ' +
            'one edge with an extension point. A cycle cannot be installed in any order.',
          involves: path,
        });
      }
      return;
    }

    if (visited.has(id)) return;

    visited.add(id);
    stack.push(id);
    onStack.add(id);

    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dependency.moduleId)) visit(dependency.moduleId);
    }

    stack.pop();
    onStack.delete(id);
  };

  for (const module of modules) visit(module.id);

  return findings;
}

/**
 * Two modules needing incompatible versions of a third.
 *
 * The installed version is checked against every range that names it. When one range is not
 * satisfied the installed version is wrong for that dependant — and which dependant loses is
 * decided by whoever installed last, which is why this fails differently on different machines.
 */
function findVersionConflicts(
  modules: readonly GraphModule[],
  byId: Map<string, GraphModule>,
): AnalysisFinding[] {
  const demands = new Map<string, Array<{ from: string; range: string }>>();

  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (!byId.has(dependency.moduleId)) continue;

      demands.set(dependency.moduleId, [
        ...(demands.get(dependency.moduleId) ?? []),
        { from: module.id, range: dependency.versionRange },
      ]);
    }
  }

  const findings: AnalysisFinding[] = [];

  for (const [id, requirements] of demands) {
    const installed = byId.get(id)!.version;
    const unsatisfied = requirements.filter(({ range }) => !satisfies(installed, range));

    if (unsatisfied.length === 0) continue;

    findings.push({
      kind: 'version_conflict',
      severity: 'error',
      moduleId: id,
      detail:
        `${id} is installed at ${installed}, which does not satisfy ` +
        unsatisfied.map(({ from, range }) => `${from} (needs ${range})`).join(', ') +
        '.',
      remediation:
        requirements.length > unsatisfied.length
          ? `Other modules need a different range of ${id}. One of them has to move — there is no ` +
            'version that satisfies all of them.'
          : `Install a version of ${id} that satisfies ${unsatisfied.map((entry) => entry.range).join(' and ')}.`,
      involves: [id, ...unsatisfied.map((entry) => entry.from)],
    });
  }

  return findings;
}

/**
 * Modules nothing reaches.
 *
 * Only computed when entry points are supplied — without them every module looks unused, and a
 * tool that reports everything reports nothing. Reachability, not "has no dependants": a module
 * depended on only by another unused module is also unused.
 */
function findUnused(
  modules: readonly GraphModule[],
  byId: Map<string, GraphModule>,
  entryPoints: readonly string[] | undefined,
): AnalysisFinding[] {
  if (!entryPoints || entryPoints.length === 0) return [];

  const reachable = new Set<string>();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);

    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dependency.moduleId)) queue.push(dependency.moduleId);
    }
  }

  return modules
    .filter((module) => !reachable.has(module.id))
    .map((module) => ({
      kind: 'unused_module' as const,
      // A warning, not an error: an unused module breaks nothing today. It enlarges the attack
      // surface and the upgrade cost, and nothing else ever complains about it.
      severity: 'warning' as const,
      moduleId: module.id,
      detail: `${module.id} is installed but nothing reaches it from ${entryPoints.join(', ')}.`,
      remediation:
        'Remove it, or wire it in. An installed module still runs its migrations, claims its ' +
        'permissions and has to be upgraded.',
    }));
}

/** Modules whose version moved across a breaking boundary since the recorded state. */
function findBreakingChanges(
  modules: readonly GraphModule[],
  previous: Readonly<Record<string, string>> | undefined,
): AnalysisFinding[] {
  if (!previous) return [];

  const findings: AnalysisFinding[] = [];

  for (const module of modules) {
    const before = previous[module.id];
    if (!before || compareVersions(module.version, before) <= 0) continue;

    if (!isBreakingChange(before, module.version)) continue;

    findings.push({
      kind: 'breaking_change',
      severity: 'warning',
      moduleId: module.id,
      detail: `${module.id} moved from ${before} to ${module.version}, which crosses a breaking boundary.`,
      remediation: `Read the migration notes for ${module.id} before deploying.`,
    });
  }

  return findings;
}

/**
 * Dependencies that point the wrong way through the layers.
 *
 * The rule is directional and the violation is always the same shape: something low-level
 * reaching up. A `core` module depending on a `product` module means core cannot be reused
 * without the product, which is the moment a framework stops being one.
 */
function findLayerViolations(
  modules: readonly GraphModule[],
  byId: Map<string, GraphModule>,
  rules: Readonly<Record<string, readonly string[]>> | undefined,
): AnalysisFinding[] {
  if (!rules) return [];

  const findings: AnalysisFinding[] = [];

  for (const module of modules) {
    const layer = module.layer;
    if (!layer) continue;

    const allowed = rules[layer];
    if (!allowed) continue;

    for (const dependency of module.dependencies) {
      const target = byId.get(dependency.moduleId);
      if (!target?.layer) continue;
      if (target.layer === layer || allowed.includes(target.layer)) continue;

      findings.push({
        kind: 'architecture_violation',
        severity: 'error',
        moduleId: module.id,
        detail: `${module.id} (${layer}) depends on ${target.id} (${target.layer}), which the ${layer} layer may not reach.`,
        remediation:
          `The ${layer} layer may depend on: ${allowed.join(', ') || 'nothing'}. Invert the ` +
          'dependency with an extension point, or move the shared piece down.',
        involves: [module.id, target.id],
      });
    }
  }

  return findings;
}

/** Dependency order, dependencies first. Assumes no cycles — check first. */
export function topologicalOrder(
  modules: readonly GraphModule[],
  byId: Map<string, GraphModule> = new Map(modules.map((module) => [module.id, module])),
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);

    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dependency.moduleId)) visit(dependency.moduleId);
    }

    ordered.push(id);
  };

  // Sorted, so the order is the same on every machine. An install order that depends on map
  // iteration is an install order that differs between a laptop and CI.
  for (const module of [...modules].sort((a, b) => (a.id < b.id ? -1 : 1))) visit(module.id);

  return ordered;
}

/** The modules that would have to be removed along with this one. */
export function dependants(modules: readonly GraphModule[], id: string): string[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const found = new Set<string>();
  const queue = [id];

  while (queue.length > 0) {
    const current = queue.pop() as string;

    for (const module of modules) {
      if (found.has(module.id) || module.id === id) continue;

      const needs = module.dependencies.some(
        (dependency) => dependency.moduleId === current && !dependency.optional,
      );

      if (needs && byId.has(module.id)) {
        found.add(module.id);
        queue.push(module.id);
      }
    }
  }

  return [...found].sort();
}
