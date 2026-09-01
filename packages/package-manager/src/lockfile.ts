import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { isValidVersion } from '@trustsystem/version-manager';

/**
 * The lockfile.
 *
 * Records exactly what is installed and what each artefact hashed to. Two jobs, and the second is
 * the one that matters:
 *
 *   1. **Reproducibility.** The same lockfile installs the same versions on every machine.
 *   2. **Tamper evidence.** The integrity hash is checked on every install, so a package whose
 *      contents changed since it was locked fails rather than installing. Without it, a
 *      compromised mirror can serve different bytes under the same version and nothing notices.
 *
 * A lockfile without hashes is a version list. The hash is the point.
 */

export const lockedPackageSchema = z
  .object({
    id: z.string().min(1).max(80),
    version: z.string().refine(isValidVersion, 'Must be a semantic version.'),
    /** SHA-256 of the artefact, hex. */
    integrity: z.string().regex(/^[a-f0-9]{64}$/, 'Must be a hex SHA-256 digest.'),
    /** Which key signed it, or null when installed unsigned. Recorded, so it can be audited. */
    signedBy: z.string().max(80).nullable().default(null),
    /** Modules that caused this one to be installed. Empty means it was asked for directly. */
    requiredBy: z.array(z.string().min(1).max(80)).default([]),
    installedAt: z.string().min(10).max(40),
  })
  .strict();

export type LockedPackage = z.infer<typeof lockedPackageSchema>;

export const lockfileSchema = z
  .object({
    /**
     * Format version of the lockfile itself.
     *
     * Separate from the framework version: an installer reading a newer lockfile format must
     * refuse rather than guess, and it cannot know that from the framework version alone.
     */
    lockfileVersion: z.literal(1),
    frameworkVersion: z.string().refine(isValidVersion, 'Must be a semantic version.'),
    packages: z.array(lockedPackageSchema).default([]),
    generatedAt: z.string().min(10).max(40),
  })
  .strict();

export type Lockfile = z.infer<typeof lockfileSchema>;

export function parseLockfile(raw: unknown): Lockfile {
  const parsed = lockfileSchema.safeParse(raw);

  if (!parsed.success) {
    const isFutureFormat =
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { lockfileVersion?: unknown }).lockfileVersion === 'number' &&
      (raw as { lockfileVersion: number }).lockfileVersion > 1;

    throw ApiError.validation(
      [
        {
          path: 'lockfile',
          message: isFutureFormat
            ? 'This lockfile was written by a newer installer. Update the CLI rather than ' +
              'letting an older one guess at a format it does not know.'
            : parsed.error.issues
                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                .join('; '),
          code: isFutureFormat ? 'lockfile_too_new' : 'lockfile_invalid',
        },
      ],
      'Invalid lockfile.',
    );
  }

  const seen = new Set<string>();

  for (const entry of parsed.data.packages) {
    if (seen.has(entry.id)) {
      throw ApiError.validation(
        [
          {
            path: 'packages',
            message:
              `"${entry.id}" appears twice. A lockfile with two versions of one package ` +
              'locks nothing — whichever is read last wins.',
            code: 'lockfile_duplicate',
          },
        ],
        'Invalid lockfile.',
      );
    }
    seen.add(entry.id);
  }

  return parsed.data;
}

export function emptyLockfile(frameworkVersion: string, now: Date): Lockfile {
  return {
    lockfileVersion: 1,
    frameworkVersion,
    packages: [],
    generatedAt: now.toISOString(),
  };
}

/** The locked entry for a package, or null. */
export function lookup(lockfile: Lockfile, id: string): LockedPackage | null {
  return lockfile.packages.find((entry) => entry.id === id) ?? null;
}

/**
 * Refuses an artefact whose bytes no longer match what was locked.
 *
 * This is the check a compromised mirror has to defeat. It runs on *every* install, including a
 * reinstall of something already present, because "already installed" is exactly when nobody
 * looks.
 */
export function assertIntegrity(locked: LockedPackage, actualDigest: string): void {
  if (locked.integrity === actualDigest) return;

  throw ApiError.forbidden(
    `Integrity check failed for ${locked.id}@${locked.version}. The lockfile records ` +
      `${locked.integrity.slice(0, 16)}… but the artefact hashes to ${actualDigest.slice(0, 16)}…. ` +
      'The contents changed since they were locked.',
  );
}

/** Sorted by id, so a lockfile diff shows what changed rather than what moved. */
export function normalize(lockfile: Lockfile): Lockfile {
  return {
    ...lockfile,
    packages: [...lockfile.packages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}
