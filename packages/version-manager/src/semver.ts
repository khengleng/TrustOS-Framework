import { ApiError } from '@trustsystem/errors';

/**
 * Semantic versioning.
 *
 * A fourth `compareSemver` in this repository, and the last one — the other three exist because
 * `@trustsystem/template-registry` must stay dependency-free for the CLI, `@trustsystem/module-sdk`
 * needed ranges, and `@trustsystem/financial-core` needed neither. This one is the complete
 * implementation: prerelease identifiers, ranges, and the precedence rules the others do not
 * need. The plan recorded in `docs/platform-governance.md` is that those three collapse into this
 * one at the next major version, when the dependency direction can change without breaking the
 * CLI's install size.
 *
 * No semver library, for the same reason as before: the framework ships to environments that
 * audit every transitive dependency, and a supply-chain review of one 200-line file is cheaper
 * than one of a package with its own dependency tree. That argument is only honest if this file
 * is actually complete against the spec, which is what the tests are for.
 */

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  /**
   * Dot-separated identifiers after `-`. Empty for a release.
   *
   * A prerelease sorts *before* the release it leads to: 1.0.0-rc.1 < 1.0.0. That is the rule
   * everybody gets wrong by sorting strings, and it is the one that decides whether an upgrade
   * check thinks a release candidate is newer than the release.
   */
  prerelease: Array<string | number>;
  /** After `+`. Carried, never compared — that is what "build metadata" means. */
  build: string;
}

const PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(value: string): SemanticVersion {
  const match = PATTERN.exec(value.trim());

  if (!match) {
    throw ApiError.validation(
      [
        {
          path: 'version',
          message:
            `"${value}" is not a semantic version. Expected major.minor.patch, optionally with ` +
            '-prerelease and +build.',
          code: 'invalid_version',
        },
      ],
      'Invalid version.',
    );
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (match[4] ?? '')
      .split('.')
      .filter(Boolean)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
    build: match[5] ?? '',
  };
}

/** True when the string parses. For validating input without throwing. */
export function isValidVersion(value: string): boolean {
  return PATTERN.test(value.trim());
}

export function formatVersion(version: SemanticVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const prerelease = version.prerelease.length > 0 ? `-${version.prerelease.join('.')}` : '';
  const build = version.build ? `+${version.build}` : '';

  return `${core}${prerelease}${build}`;
}

/**
 * Precedence, per the specification. Returns -1, 0 or 1.
 *
 * Build metadata is ignored, and a version *with* a prerelease is lower than the same version
 * without one. Numeric prerelease identifiers compare numerically — so `rc.2` is above `rc.10`
 * only if you compare them as strings, which is the bug this exists to avoid.
 */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);

  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];

    // A shorter set of identifiers is lower, when all preceding ones are equal.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftIsNumber = typeof left === 'number';
    const rightIsNumber = typeof right === 'number';

    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;

    return left > right ? 1 : -1;
  }

  return 0;
}

export const isNewer = (candidate: string, current: string): boolean =>
  compareVersions(candidate, current) > 0;

export const isPrerelease = (value: string): boolean => parseVersion(value).prerelease.length > 0;

/** How two versions differ. `null` when they are the same release. */
export type VersionChange = 'major' | 'minor' | 'patch' | 'prerelease' | null;

export function versionChange(from: string, to: string): VersionChange {
  const a = parseVersion(from);
  const b = parseVersion(to);

  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  if (formatVersion({ ...a, build: '' }) !== formatVersion({ ...b, build: '' }))
    return 'prerelease';

  return null;
}

/**
 * Whether moving between two versions is allowed to break something.
 *
 * Below 1.0.0 the *minor* is the breaking position — `0.2.0` may break `0.1.0`. Treating 0.x as
 * "anything goes" is how a framework at 0.9 breaks every application on a patch release and calls
 * it compliant.
 */
export function isBreakingChange(from: string, to: string): boolean {
  const a = parseVersion(from);
  const b = parseVersion(to);

  if (a.major !== b.major) return true;
  if (a.major === 0 && a.minor !== b.minor) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Ranges

/**
 * A version range.
 *
 * Four forms, deliberately: exact, caret, tilde and `>=`. Not the full grammar — no unions, no
 * hyphens, no `*`. Every form omitted is one a module author cannot express, and every one of
 * them expresses "I do not know what I depend on" more precisely than the framework wants to
 * support. A dependency that genuinely needs a union is a dependency that needs a conversation.
 */
export type RangeOperator = 'exact' | 'caret' | 'tilde' | 'gte';

export interface VersionRange {
  operator: RangeOperator;
  version: string;
  raw: string;
}

export function parseRange(raw: string): VersionRange {
  const trimmed = raw.trim();

  const operator: RangeOperator = trimmed.startsWith('^')
    ? 'caret'
    : trimmed.startsWith('~')
      ? 'tilde'
      : trimmed.startsWith('>=')
        ? 'gte'
        : 'exact';

  const version = trimmed.replace(/^(\^|~|>=)/, '').trim();

  if (!isValidVersion(version)) {
    throw ApiError.validation(
      [
        {
          path: 'range',
          message:
            `"${raw}" is not a supported version range. Use an exact version, ^1.2.3, ~1.2.3 ` +
            'or >=1.2.3 — unions and wildcards are deliberately unsupported.',
          code: 'invalid_range',
        },
      ],
      'Invalid version range.',
    );
  }

  return { operator, version, raw: trimmed };
}

/**
 * Whether a version satisfies a range.
 *
 * A prerelease never satisfies a range unless the range itself names a prerelease of the same
 * core version. `^1.0.0` matching `2.0.0-rc.1` would install a release candidate of the next
 * major into an application that asked for compatible updates, which is the single most
 * surprising thing a package manager can do.
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseRange(range);
  const candidate = parseVersion(version);
  const target = parseVersion(parsed.version);

  if (candidate.prerelease.length > 0) {
    const sameCore =
      candidate.major === target.major &&
      candidate.minor === target.minor &&
      candidate.patch === target.patch;

    if (!sameCore || target.prerelease.length === 0) return false;
  }

  switch (parsed.operator) {
    case 'exact':
      return compareVersions(version, parsed.version) === 0;

    case 'gte':
      return compareVersions(version, parsed.version) >= 0;

    case 'tilde':
      // Patch-level: >=1.2.3 <1.3.0.
      return (
        compareVersions(version, parsed.version) >= 0 &&
        candidate.major === target.major &&
        candidate.minor === target.minor
      );

    case 'caret': {
      if (compareVersions(version, parsed.version) < 0) return false;

      // Below 1.0.0 the minor is the breaking position, so ^0.2.1 is >=0.2.1 <0.3.0.
      if (target.major === 0) {
        return candidate.major === 0 && candidate.minor === target.minor;
      }

      return candidate.major === target.major;
    }
  }
}

/** The highest of the given versions that satisfies the range, or null. */
export function maxSatisfying(versions: readonly string[], range: string): string | null {
  const matching = versions.filter((version) => satisfies(version, range));

  if (matching.length === 0) return null;

  return matching.reduce((best, candidate) =>
    compareVersions(candidate, best) > 0 ? candidate : best,
  );
}

/** Sorts ascending by precedence. A copy — sorting a caller's array in place surprises them. */
export function sortVersions(versions: readonly string[]): string[] {
  return [...versions].sort(compareVersions);
}

/** The highest version in a list. */
export function latestVersion(versions: readonly string[]): string | null {
  return sortVersions(versions).pop() ?? null;
}
