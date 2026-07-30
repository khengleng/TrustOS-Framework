import { z } from 'zod';

/**
 * Module identity and versioning.
 *
 * A module id is part of a permanent contract. It appears in permission keys,
 * audit actions, feature-flag keys, environment variable names and the
 * `modules` array of a generated application's `trustos.json`. Renaming one
 * silently revokes permissions and orphans audit history, so ids are added,
 * never renamed — the same rule the framework applies to permission keys.
 */

export const moduleIdSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    'A module id must be lowercase words separated by single hyphens, e.g. "feature-flags".',
  );

export type ModuleId = z.infer<typeof moduleIdSchema>;

/** Exact semantic version. A module pins its own version; it does not float. */
export const moduleVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'Must be an exact semantic version such as 0.1.0.');

/**
 * A dependency range.
 *
 * Only two forms are accepted: an exact version, or a caret range. Richer
 * ranges (`>=`, `||`, `x`) exist to express uncertainty about what a dependency
 * will do, and a module graph that is resolved at install time and reviewed in
 * one repository has no use for that uncertainty.
 */
export const versionRangeSchema = z
  .string()
  .regex(/^\^?\d+\.\d+\.\d+$/, 'Must be an exact version (1.2.3) or a caret range (^1.2.3).');

/**
 * Lifecycle stage, which is advisory for humans and load-bearing for the
 * installer: it refuses to install a `deprecated` module without `--force`.
 */
export const moduleStabilitySchema = z.enum(['experimental', 'stable', 'deprecated']);
export type ModuleStability = z.infer<typeof moduleStabilitySchema>;

export const moduleMetadataSchema = z
  .object({
    id: moduleIdSchema,
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    version: moduleVersionSchema,
    /** Lowest framework version this module is known to work against. */
    minimumFrameworkVersion: moduleVersionSchema,
    /** Team accountable for the module. Not decorative; see docs/modules.md. */
    owner: z.string().min(1).max(120),
    stability: moduleStabilitySchema.default('experimental'),
    /** Free-form discovery tags, e.g. ['messaging', 'delivery']. */
    tags: z.array(z.string().min(1).max(40)).default([]),
  })
  .strict();

export type ModuleMetadata = z.infer<typeof moduleMetadataSchema>;

export const moduleDependencySchema = z
  .object({
    moduleId: moduleIdSchema,
    versionRange: versionRangeSchema,
    /**
     * An optional dependency is not installed automatically and its absence is
     * not an error; the depending module degrades instead. Used where a module
     * can work standalone but works better alongside another.
     */
    optional: z.boolean().default(false),
    /** Why the dependency exists. Required, so a graph edge is explainable. */
    reason: z.string().min(1).max(200),
  })
  .strict();

export type ModuleDependency = z.infer<typeof moduleDependencySchema>;

// ---------------------------------------------------------------------------
// Version comparison
//
// Implemented here rather than taken from a dependency because the whole of
// what the module system needs is "is this version at least that one" and "does
// it satisfy a caret range". A semver library would add a transitive dependency
// to every module package to answer two questions in twenty lines.
//
// `@trustos/template-registry` carries its own `compareSemver` for the same
// reason and must stay dependency-free for the CLI; this one additionally
// understands ranges, which templates do not use.
// ---------------------------------------------------------------------------

/** Returns <0, 0 or >0, comparing major, then minor, then patch. */
export function compareSemver(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^[\^~=v]/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** True when `version` is at least `minimum`. */
export function satisfiesMinimum(version: string, minimum: string): boolean {
  return compareSemver(version, minimum) >= 0;
}

/**
 * True when `version` satisfies `range`.
 *
 * Caret semantics follow npm, including the pre-1.0 rule: `^0.2.3` allows
 * `0.2.x` but not `0.3.0`. That rule matters here because every module in this
 * repository is still `0.x`, so treating `^0.1.0` as "any 0.x" would let a
 * breaking change through unnoticed.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  if (!range.startsWith('^')) return compareSemver(version, range) === 0;

  const minimum = range.slice(1);
  if (compareSemver(version, minimum) < 0) return false;

  const [major = 0, minor = 0] = minimum.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [candidateMajor = 0, candidateMinor = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);

  if (major > 0) return candidateMajor === major;
  // 0.x: the minor acts as the major.
  return candidateMajor === 0 && candidateMinor === minor;
}
