import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import {
  compareVersions,
  isPrerelease,
  isValidVersion,
  parseVersion,
} from '@trustsystem/version-manager';

/**
 * Release channels and the support lifecycle.
 *
 * A release moves through channels in one direction and reaches one of two ends: superseded, or
 * end-of-life. The value of writing that down is that **support dates become data rather than
 * intentions**. "We support the last two majors" is a sentence; a per-release
 * `securitySupportUntil` is something `trustos upgrade` can read and act on.
 *
 * The rule that matters most: **end-of-life is announced, never discovered.** A release reaches
 * EOL on a date set when it was published, and the date only ever moves later. Shortening support
 * after the fact is the thing that strands deployments.
 */

export const RELEASE_CHANNELS = ['development', 'beta', 'rc', 'stable', 'lts'] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export const SUPPORT_STATES = [
  'active',
  'maintenance',
  'security-only',
  'deprecated',
  'eol',
] as const;
export type SupportState = (typeof SUPPORT_STATES)[number];

/**
 * The only permitted channel transitions.
 *
 * Forward only. A stable release that goes back to beta is a stable release nobody can trust —
 * the whole point of the channel is that it stops changing.
 */
const CHANNEL_ORDER: Record<ReleaseChannel, number> = {
  development: 0,
  beta: 1,
  rc: 2,
  stable: 3,
  lts: 4,
};

export const releaseSchema = z
  .object({
    version: z.string().refine(isValidVersion, 'Must be a semantic version.'),
    channel: z.enum(RELEASE_CHANNELS),
    releasedAt: z.string().min(10).max(40),
    /** Active support ends here: no more features, bug fixes continue. */
    activeUntil: z.string().min(10).max(40).optional(),
    /** Security fixes stop here. After this, the release is end-of-life. */
    securitySupportUntil: z.string().min(10).max(40).optional(),
    /** What replaced it. Required once deprecated. */
    supersededBy: z.string().max(40).optional(),
    notes: z.string().max(4000).default(''),
    /** Set when a release is withdrawn after publication, with the reason. */
    withdrawn: z.string().max(400).optional(),
  })
  .strict()
  .superRefine((release, ctx) => {
    const prerelease = isPrerelease(release.version);
    const stableChannel = release.channel === 'stable' || release.channel === 'lts';

    if (prerelease && stableChannel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channel'],
        message: `${release.version} carries a prerelease identifier, so it cannot be ${release.channel}.`,
      });
    }

    if (!prerelease && (release.channel === 'beta' || release.channel === 'rc')) {
      /*
       * A "beta" with no prerelease identifier installs by default under a caret range, because
       * nothing in the version says it is a beta. The channel is metadata; the version is what
       * package managers read.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message:
          `A ${release.channel} release must carry a prerelease identifier — ${release.version}-` +
          `${release.channel}.1 — or it installs by default under a caret range.`,
      });
    }

    if (
      release.activeUntil &&
      release.securitySupportUntil &&
      release.activeUntil > release.securitySupportUntil
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['securitySupportUntil'],
        message: 'Security support cannot end before active support does.',
      });
    }

    if (release.channel === 'lts' && !release.securitySupportUntil) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['securitySupportUntil'],
        message:
          'An LTS release must state when its security support ends. "Long term" with no date is ' +
          'a promise nobody can plan against.',
      });
    }
  });

export type Release = z.infer<typeof releaseSchema>;

export class ReleaseManager {
  private readonly releases: Release[];

  constructor(releases: readonly unknown[] = []) {
    this.releases = releases
      .map((release) => releaseSchema.parse(release))
      .sort((a, b) => compareVersions(a.version, b.version));
  }

  all(): readonly Release[] {
    return this.releases;
  }

  find(version: string): Release | null {
    return this.releases.find((release) => release.version === version) ?? null;
  }

  /** The newest release on a channel. What `trustos upgrade` offers by default. */
  latest(channel: ReleaseChannel = 'stable'): Release | null {
    const onChannel = this.releases.filter(
      (release) => release.channel === channel && !release.withdrawn,
    );
    return onChannel[onChannel.length - 1] ?? null;
  }

  /** Every release still receiving security fixes. */
  supported(now: Date): Release[] {
    return this.releases.filter((release) => this.stateOf(release, now) !== 'eol');
  }

  /**
   * Where a release is in its life.
   *
   * A withdrawn release is end-of-life whatever its dates say — it was pulled, and the dates
   * describe a plan that no longer applies.
   */
  stateOf(release: Release, now: Date): SupportState {
    if (release.withdrawn) return 'eol';

    const today = now.toISOString().slice(0, 10);

    if (release.securitySupportUntil && today > release.securitySupportUntil) return 'eol';
    if (release.supersededBy && release.channel !== 'lts') return 'deprecated';
    if (release.activeUntil && today > release.activeUntil) return 'security-only';
    if (release.channel === 'lts') return 'maintenance';

    return 'active';
  }

  /** True when a version no longer receives security fixes. The one `upgrade` treats as urgent. */
  isOutOfSupport(version: string, now: Date): boolean {
    const release = this.find(version);
    // An unknown version is treated as unsupported: it is not in the register, so nobody has
    // committed to fixing it.
    if (!release) return true;

    return this.stateOf(release, now) === 'eol';
  }

  /** Versions that carry a security fix, for `recommendUpgrade`. */
  securityReleases(): string[] {
    return this.releases
      .filter((release) => /security/i.test(release.notes))
      .map((release) => release.version);
  }

  /**
   * Promotes a release along the channel order.
   *
   * Forward only, and never onto a stable channel from a version that carries a prerelease
   * identifier. Promotion is where "we shipped the rc as stable" happens, and the version string
   * is what package managers read.
   */
  promote(version: string, to: ReleaseChannel): Release {
    const release = this.find(version);
    if (!release) throw ApiError.notFound(`No release ${version} is registered.`);

    if (CHANNEL_ORDER[to] <= CHANNEL_ORDER[release.channel]) {
      throw ApiError.conflict(
        `Cannot move ${version} from ${release.channel} to ${to}. Channels move forward only — a ` +
          'stable release that goes back to beta is one nobody can trust.',
      );
    }

    if ((to === 'stable' || to === 'lts') && isPrerelease(version)) {
      throw ApiError.conflict(
        `${version} carries a prerelease identifier and cannot be promoted to ${to}. Cut ` +
          `${parseVersion(version).major}.${parseVersion(version).minor}.${parseVersion(version).patch} first.`,
      );
    }

    release.channel = to;
    return release;
  }

  /**
   * Extends support. Only ever later.
   *
   * Shortening support after publication is the thing that strands deployments: a team plans an
   * upgrade for Q3 against a date, and the date moves to Q1.
   */
  extendSupport(version: string, until: string): Release {
    const release = this.find(version);
    if (!release) throw ApiError.notFound(`No release ${version} is registered.`);

    if (release.securitySupportUntil && until < release.securitySupportUntil) {
      throw ApiError.conflict(
        `Cannot shorten support for ${version} from ${release.securitySupportUntil} to ${until}. ` +
          'Teams plan upgrades against these dates.',
      );
    }

    release.securitySupportUntil = until;
    return release;
  }

  /** Withdraws a published release. Recorded, never deleted. */
  withdraw(version: string, reason: string): Release {
    const release = this.find(version);
    if (!release) throw ApiError.notFound(`No release ${version} is registered.`);

    if (!reason.trim()) {
      throw ApiError.validation(
        [{ path: 'reason', message: 'A withdrawal must say why.', code: 'reason_required' }],
        'Withdrawal refused.',
      );
    }

    release.withdrawn = reason;
    return release;
  }
}
