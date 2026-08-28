import { ApiError } from '@trustos/errors';
import { analyzeDependencies, dependants, type GraphModule } from '@trustos/dependency-analyzer';
import { compareVersions, maxSatisfying, satisfies } from '@trustos/version-manager';
import { assertIntegrity, lookup, normalize, type Lockfile, type LockedPackage } from './lockfile';

/**
 * Install, update, remove and rollback.
 *
 * **Offline by design.** Nothing here fetches. The installer is handed the artefacts it may use
 * and refuses anything else — which is what makes an air-gapped install the same operation as a
 * connected one, rather than a degraded mode nobody tests.
 *
 * **Plan, then apply.** Every operation produces a plan first: what would be installed, removed,
 * upgraded, and what it would break. The plan is inspectable, and `--dry-run` is not a special
 * path but simply not calling `apply`. A dry run that goes down a different code path is a dry
 * run that does not predict the real one.
 *
 * **Rollback is a restore, not a downgrade.** Going back means reinstating the previous lockfile
 * and its artefacts, because migrations run forward and a schema does not un-migrate.
 */

export interface AvailablePackage {
  id: string;
  version: string;
  /** SHA-256 of the artefact. Checked against the lockfile on every install. */
  integrity: string;
  signedBy?: string | null;
  dependencies?: Array<{ moduleId: string; versionRange: string; optional?: boolean }>;
  minimumFrameworkVersion?: string;
}

export type PlanAction = 'install' | 'update' | 'remove' | 'unchanged';

export interface PlanStep {
  action: PlanAction;
  id: string;
  fromVersion: string | null;
  toVersion: string | null;
  /** Why it is in the plan: asked for, or pulled in by something else. */
  reason: string;
}

export interface InstallPlan {
  steps: PlanStep[];
  /** Problems that would make the plan fail. Non-empty means `apply` refuses. */
  conflicts: string[];
  /** Things worth knowing that do not block. */
  warnings: string[];
  ok: boolean;
}

export interface PlanOptions {
  lockfile: Lockfile;
  available: readonly AvailablePackage[];
  frameworkVersion: string;
}

const byId = (packages: readonly AvailablePackage[]) => {
  const map = new Map<string, AvailablePackage[]>();
  for (const entry of packages) map.set(entry.id, [...(map.get(entry.id) ?? []), entry]);
  return map;
};

/**
 * A plan to install one package and everything it needs.
 *
 * Resolution is *lowest satisfying wins is wrong, highest satisfying wins is right*: a range says
 * "anything from here up to the boundary", and picking the bottom of that range installs the
 * oldest acceptable version, which is the one with the security fixes missing.
 */
export function planInstall(
  request: { id: string; versionRange?: string },
  options: PlanOptions,
): InstallPlan {
  const catalogue = byId(options.available);
  const steps: PlanStep[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];

  const resolve = (id: string, range: string, requiredBy: string | null): void => {
    if (steps.some((step) => step.id === id)) return;

    const candidates = catalogue.get(id) ?? [];

    if (candidates.length === 0) {
      conflicts.push(
        `"${id}" is not available offline. The installer never fetches — supply the artefact, or ` +
          'point at a local catalogue that has it.',
      );
      return;
    }

    const chosen = maxSatisfying(
      candidates.map((entry) => entry.version),
      range,
    );

    if (!chosen) {
      conflicts.push(
        `No available version of "${id}" satisfies ${range}. Available: ` +
          `${candidates.map((entry) => entry.version).join(', ')}.`,
      );
      return;
    }

    const entry = candidates.find((candidate) => candidate.version === chosen)!;

    if (
      entry.minimumFrameworkVersion &&
      compareVersions(options.frameworkVersion, entry.minimumFrameworkVersion) < 0
    ) {
      conflicts.push(
        `${id}@${chosen} needs framework ${entry.minimumFrameworkVersion} or newer; this is ` +
          `${options.frameworkVersion}.`,
      );
      return;
    }

    const locked = lookup(options.lockfile, id);

    if (locked && compareVersions(chosen, locked.version) < 0) {
      /*
       * The plan wants to move an installed package backwards to satisfy something new. Refused
       * rather than done: a silent downgrade of a package that was working, to accommodate one
       * that was just added, is a change nobody chose and the first sign of it is a regression in
       * an unrelated feature.
       */
      conflicts.push(
        `Installing ${requiredBy ?? id} would move "${id}" from ${locked.version} back to ` +
          `${chosen}, because ${requiredBy ?? 'the request'} needs ${range}. Downgrading an ` +
          'installed package to satisfy a new one is a change nobody chose — one of them has to move.',
      );
      return;
    }

    steps.push({
      action: !locked ? 'install' : locked.version === chosen ? 'unchanged' : 'update',
      id,
      fromVersion: locked?.version ?? null,
      toVersion: chosen,
      reason: requiredBy ? `required by ${requiredBy}` : 'requested',
    });

    if (entry.signedBy === null || entry.signedBy === undefined) {
      warnings.push(`${id}@${chosen} is unsigned.`);
    }

    for (const dependency of entry.dependencies ?? []) {
      if (dependency.optional && !catalogue.has(dependency.moduleId)) continue;
      resolve(dependency.moduleId, dependency.versionRange, id);
    }
  };

  resolve(request.id, request.versionRange ?? '>=0.0.0', null);

  conflicts.push(...detectConflicts(steps, catalogue, options.lockfile));

  return {
    steps,
    conflicts,
    warnings,
    ok: conflicts.length === 0,
  };
}

/**
 * Ranges that cannot all be satisfied by the versions the plan chose.
 *
 * Reported as a plan-level conflict rather than resolved by backtracking. Backtracking would pick
 * *some* solution, and the solution it picks is one nobody chose — a downgrade of a package that
 * was working, to satisfy a package that was just added.
 */
function detectConflicts(
  steps: readonly PlanStep[],
  catalogue: Map<string, AvailablePackage[]>,
  lockfile: Lockfile,
): string[] {
  const chosen = new Map(steps.map((step) => [step.id, step.toVersion as string]));

  for (const entry of lockfile.packages) {
    if (!chosen.has(entry.id)) chosen.set(entry.id, entry.version);
  }

  const conflicts: string[] = [];

  for (const [id, version] of chosen) {
    const entry = (catalogue.get(id) ?? []).find((candidate) => candidate.version === version);

    for (const dependency of entry?.dependencies ?? []) {
      const installed = chosen.get(dependency.moduleId);
      if (!installed || dependency.optional) continue;

      if (!satisfies(installed, dependency.versionRange)) {
        conflicts.push(
          `${id}@${version} needs ${dependency.moduleId} ${dependency.versionRange}, but the plan ` +
            `settles on ${installed}. No single version satisfies everything — one of them has to move.`,
        );
      }
    }
  }

  return conflicts;
}

/** A plan to remove a package, refusing while something needs it. */
export function planRemove(id: string, options: PlanOptions): InstallPlan {
  const locked = lookup(options.lockfile, id);

  if (!locked) {
    return {
      steps: [],
      conflicts: [`"${id}" is not installed.`],
      warnings: [],
      ok: false,
    };
  }

  const graph: GraphModule[] = options.lockfile.packages.map((entry) => ({
    id: entry.id,
    version: entry.version,
    dependencies:
      options.available.find(
        (candidate) => candidate.id === entry.id && candidate.version === entry.version,
      )?.dependencies ?? [],
  }));

  const needed = dependants(graph, id);

  return {
    steps: [
      { action: 'remove', id, fromVersion: locked.version, toVersion: null, reason: 'requested' },
    ],
    conflicts:
      needed.length > 0
        ? [
            `Cannot remove "${id}": ${needed.join(', ')} depend on it. Remove them first — ` +
              'cascading would take modules with it that nobody reviewed.',
          ]
        : [],
    warnings: [],
    ok: needed.length === 0,
  };
}

export interface ApplyResult {
  lockfile: Lockfile;
  /** The lockfile as it was, for rollback. */
  previous: Lockfile;
  applied: PlanStep[];
}

/**
 * Applies a plan, verifying integrity as it goes.
 *
 * Refuses a plan with conflicts rather than applying the part that works. A half-applied plan
 * leaves a deployment in a state no lockfile describes, and the next command has to guess.
 */
export function applyPlan(
  plan: InstallPlan,
  options: PlanOptions & { now: Date; digests?: Readonly<Record<string, string>> },
): ApplyResult {
  if (!plan.ok) {
    throw ApiError.conflict(
      `Refusing to apply a plan with ${plan.conflicts.length} conflict(s): ${plan.conflicts.join(' ')}`,
    );
  }

  const packages = new Map(options.lockfile.packages.map((entry) => [entry.id, entry]));
  const applied: PlanStep[] = [];

  for (const step of plan.steps) {
    if (step.action === 'unchanged') {
      /*
       * Still verified. "Already installed at the right version" is precisely when nobody looks,
       * and it is the state a compromised mirror wants a deployment to be in.
       */
      const locked = packages.get(step.id);
      const digest = options.digests?.[`${step.id}@${step.toVersion}`];

      if (locked && digest !== undefined) assertIntegrity(locked, digest);
      continue;
    }

    if (step.action === 'remove') {
      packages.delete(step.id);
      applied.push(step);
      continue;
    }

    const entry = options.available.find(
      (candidate) => candidate.id === step.id && candidate.version === step.toVersion,
    );

    if (!entry) {
      throw ApiError.conflict(
        `${step.id}@${step.toVersion} was in the plan but is not in the available set. The ` +
          'catalogue changed between planning and applying.',
      );
    }

    /*
     * Integrity is checked against the *lockfile* when there is one, so a package that was locked
     * at one digest and now hashes to another fails — including on a reinstall of something
     * already present, which is exactly when nobody looks.
     */
    const actual = options.digests?.[`${entry.id}@${entry.version}`] ?? entry.integrity;
    const previouslyLocked = packages.get(step.id);

    if (previouslyLocked && previouslyLocked.version === entry.version) {
      assertIntegrity(previouslyLocked, actual);
    }

    const record: LockedPackage = {
      id: entry.id,
      version: entry.version,
      integrity: actual,
      signedBy: entry.signedBy ?? null,
      requiredBy: plan.steps
        .filter((candidate) => candidate.reason === `required by ${entry.id}`)
        .map((candidate) => candidate.id),
      installedAt: options.now.toISOString(),
    };

    packages.set(entry.id, record);
    applied.push(step);
  }

  return {
    previous: options.lockfile,
    lockfile: normalize({
      ...options.lockfile,
      packages: [...packages.values()],
      generatedAt: options.now.toISOString(),
    }),
    applied,
  };
}

/**
 * Restores a previous lockfile.
 *
 * Called rollback because that is the word people use, but it is a *restore*: the artefacts named
 * by the previous lockfile are reinstated. Anything a migration did to the database is not undone
 * here — `@trustos/migration-tools` owns that, and it needs a backup rather than a reversal.
 */
export function rollback(previous: Lockfile, now: Date): Lockfile {
  return normalize({ ...previous, generatedAt: now.toISOString() });
}

/** Every package with an available version newer than the locked one. */
export function outdated(
  lockfile: Lockfile,
  available: readonly AvailablePackage[],
): Array<{ id: string; current: string; latest: string }> {
  const catalogue = byId(available);
  const results: Array<{ id: string; current: string; latest: string }> = [];

  for (const entry of lockfile.packages) {
    const versions = (catalogue.get(entry.id) ?? []).map((candidate) => candidate.version);
    const latest = versions.reduce<string | null>(
      (best, candidate) =>
        best === null || compareVersions(candidate, best) > 0 ? candidate : best,
      null,
    );

    if (latest && compareVersions(latest, entry.version) > 0) {
      results.push({ id: entry.id, current: entry.version, latest });
    }
  }

  return results;
}

/** A plan that brings everything to its newest compatible version. */
export function planUpdateAll(options: PlanOptions): InstallPlan {
  const merged: InstallPlan = { steps: [], conflicts: [], warnings: [], ok: true };

  for (const entry of options.lockfile.packages) {
    const plan = planInstall({ id: entry.id, versionRange: `^${entry.version}` }, options);

    for (const step of plan.steps) {
      if (!merged.steps.some((existing) => existing.id === step.id)) merged.steps.push(step);
    }

    merged.conflicts.push(...plan.conflicts);
    merged.warnings.push(...plan.warnings);
  }

  merged.ok = merged.conflicts.length === 0;
  return merged;
}

/** Checks the whole lockfile against a fresh set of digests. The command a security review runs. */
export function verifyLockfile(
  lockfile: Lockfile,
  digests: Readonly<Record<string, string>>,
): Array<{ id: string; expected: string; actual: string | null }> {
  return lockfile.packages
    .map((entry) => ({
      id: entry.id,
      expected: entry.integrity,
      actual: digests[`${entry.id}@${entry.version}`] ?? null,
    }))
    .filter((result) => result.actual !== result.expected);
}

export { analyzeDependencies };
