import { z } from 'zod';
import { compareVersions, isBreakingChange } from './semver';

/**
 * Version history.
 *
 * What shipped, when, and what it broke. The reason this is data rather than a changelog file:
 * `trustos upgrade` needs to tell somebody moving from 0.2.1 to 0.5.0 what happens in between,
 * and reading three years of prose to answer that is how people skip the reading.
 *
 * `breaking` is not derived from the version number alone. A major release may contain no
 * breaking change a given application will notice, and a 0.x minor may contain several — so the
 * entry states what actually broke, and `isBreakingChange` is only the fallback.
 */

export const versionEntrySchema = z
  .object({
    version: z.string().min(5).max(40),
    /** ISO date. A release nobody can date is a release nobody can correlate with an incident. */
    releasedAt: z.string().min(10).max(40),
    summary: z.string().min(1).max(300),
    /** What a maintainer must change. Empty means nothing broke. */
    breakingChanges: z.array(z.string().min(1).max(300)).default([]),
    /** Security fixes, so `recommendUpgrade` can raise the urgency. */
    securityFixes: z.array(z.string().min(1).max(300)).default([]),
    /** Highlights, for release notes. */
    features: z.array(z.string().min(1).max(300)).default([]),
    fixes: z.array(z.string().min(1).max(300)).default([]),
    /** What this release deprecated, and what replaced it. */
    deprecations: z
      .array(
        z
          .object({
            what: z.string().min(1).max(160),
            replacement: z.string().min(1).max(160),
            removedIn: z.string().max(40).optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type VersionEntry = z.infer<typeof versionEntrySchema>;

export class VersionHistory {
  private readonly entries: VersionEntry[];

  constructor(entries: readonly unknown[] = []) {
    this.entries = entries
      .map((entry) => versionEntrySchema.parse(entry))
      .sort((a, b) => compareVersions(a.version, b.version));
  }

  all(): readonly VersionEntry[] {
    return this.entries;
  }

  find(version: string): VersionEntry | null {
    return this.entries.find((entry) => entry.version === version) ?? null;
  }

  latest(): VersionEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  /**
   * Everything released after `from`, up to and including `to`.
   *
   * Half-open at the bottom: the version you are on is not part of the upgrade. Including it
   * would show a team the notes for a release they have been running for a year.
   */
  between(from: string, to: string): VersionEntry[] {
    return this.entries.filter(
      (entry) =>
        compareVersions(entry.version, from) > 0 && compareVersions(entry.version, to) <= 0,
    );
  }

  /** Every breaking change an upgrade would cross, with the version that introduced it. */
  breakingChangesBetween(from: string, to: string): Array<{ version: string; change: string }> {
    return this.between(from, to).flatMap((entry) =>
      entry.breakingChanges.map((change) => ({ version: entry.version, change })),
    );
  }

  /** Every security fix an upgrade would pick up. */
  securityFixesBetween(from: string, to: string): string[] {
    return this.between(from, to)
      .filter((entry) => entry.securityFixes.length > 0)
      .map((entry) => entry.version);
  }

  /**
   * Whether crossing this range breaks anything.
   *
   * Prefers the recorded facts and falls back to the version numbers. A range with no recorded
   * entries across a major boundary is reported as breaking: absence of a note is not evidence
   * that nothing broke, and the safe assumption is the one that makes somebody read.
   */
  isBreaking(from: string, to: string): boolean {
    const crossed = this.between(from, to);

    if (crossed.some((entry) => entry.breakingChanges.length > 0)) return true;
    if (crossed.length === 0) return isBreakingChange(from, to);

    return isBreakingChange(from, to);
  }

  /** Deprecations announced in the range and not yet removed. */
  activeDeprecations(
    from: string,
    to: string,
  ): Array<VersionEntry['deprecations'][number] & { announcedIn: string }> {
    return this.between(from, to).flatMap((entry) =>
      entry.deprecations.map((deprecation) => ({ ...deprecation, announcedIn: entry.version })),
    );
  }
}
