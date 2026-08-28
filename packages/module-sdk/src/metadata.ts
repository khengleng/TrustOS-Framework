import { z } from 'zod';
import { compareVersions, satisfies } from '@trustos/version-manager';

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
// Delegated to `@trustos/version-manager`, which is the framework's one complete implementation.
//
// This was a local copy, justified at the time by keeping the module system free of a semver
// dependency. The justification did not survive: the copy stripped prerelease identifiers, so
// `1.0.0-rc.1` and `1.0.0` compared equal and `^1.0.0` accepted `2.0.0-rc.1`. Both are exactly
// the failures a version comparison exists to prevent, and neither was visible without a test.
//
// `version-manager` depends only on `@trustos/errors`, which every module package already has.
// ---------------------------------------------------------------------------

/** Returns <0, 0 or >0, comparing major, then minor, then patch. */
export function compareSemver(left: string, right: string): number {
  return compareVersions(left, right);
}

/** True when `version` is at least `minimum`. */
export function satisfiesMinimum(version: string, minimum: string): boolean {
  return compareSemver(version, minimum) >= 0;
}

/**
 * True when `version` satisfies `range`.
 *
 * Delegates to `@trustos/version-manager`. Caret semantics follow npm, including the pre-1.0
 * rule — `^0.2.3` allows `0.2.x` but not `0.3.0` — which matters because every module here is
 * still `0.x`, so treating `^0.1.0` as "any 0.x" would let a breaking change through unnoticed.
 *
 * The local copy this replaced also ignored prerelease identifiers, so `^1.0.0` accepted
 * `2.0.0-rc.1`: a release candidate of the *next major* installed into an application that asked
 * for compatible updates.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  return satisfies(version, range);
}
