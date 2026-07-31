import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { compareVersions, isBreakingChange, satisfies, versionChange } from './semver';

/**
 * The compatibility matrix.
 *
 * A matrix answers one question — *may these two versions run together* — and it answers it from
 * recorded fact rather than from a rule. That distinction is the whole point.
 *
 * The tempting design is a rule: "a module works with any framework at or above its minimum".
 * That rule is right until the day the framework removes something, and then it is silently wrong
 * for every module ever published. A matrix records what was *tested*, and an untested pair is
 * reported as unknown rather than as compatible. Unknown is a useful answer; a confident wrong
 * answer is not.
 *
 * So there are three states, not two: `compatible`, `incompatible`, `unknown`. Callers decide
 * what to do with unknown — the CLI warns, CI fails, an interactive upgrade asks.
 */

export const COMPATIBILITY_VERDICTS = ['compatible', 'incompatible', 'unknown'] as const;
export type CompatibilityVerdict = (typeof COMPATIBILITY_VERDICTS)[number];

/** What kind of thing is being checked against the framework. */
export const COMPATIBILITY_SUBJECTS = [
  'module',
  'template',
  'plugin',
  'cli',
  'database',
  'api',
] as const;

export type CompatibilitySubject = (typeof COMPATIBILITY_SUBJECTS)[number];

export const matrixEntrySchema = z
  .object({
    subject: z.enum(COMPATIBILITY_SUBJECTS),
    /** What the entry is about: a module id, a template id, `cli`, `postgresql`. */
    id: z.string().min(1).max(80),
    /** Version range of the subject this entry covers. */
    subjectRange: z.string().min(1).max(40),
    /** Framework version range it is known to work with. */
    frameworkRange: z.string().min(1).max(40),
    verdict: z.enum(COMPATIBILITY_VERDICTS),
    /**
     * Why. Required for anything other than `compatible`.
     *
     * An `incompatible` with no reason is an entry nobody can act on: the reader cannot tell
     * whether to wait for a fix, change their own code, or pin.
     */
    note: z.string().max(400).default(''),
    /** When this pairing was last verified. Recorded, so a stale entry is visible as stale. */
    verifiedAt: z.string().min(4).max(40).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.verdict !== 'compatible' && entry.note.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message:
          `An entry marked "${entry.verdict}" must say why. Without a reason the reader cannot ` +
          'tell whether to wait for a fix, change their code, or pin a version.',
      });
    }
  });

export type MatrixEntry = z.infer<typeof matrixEntrySchema>;

export class CompatibilityMatrix {
  private readonly entries: MatrixEntry[];

  constructor(entries: readonly unknown[] = []) {
    this.entries = entries.map((entry) => matrixEntrySchema.parse(entry));
  }

  add(entry: unknown): void {
    this.entries.push(matrixEntrySchema.parse(entry));
  }

  all(): readonly MatrixEntry[] {
    return this.entries;
  }

  /**
   * The verdict for one pairing.
   *
   * When several entries match, the *most severe* wins: one recorded incompatibility outranks any
   * number of recorded successes. A pairing that worked in three configurations and broke in a
   * fourth is a pairing that breaks.
   */
  check(
    subject: CompatibilitySubject,
    id: string,
    subjectVersion: string,
    frameworkVersion: string,
  ): { verdict: CompatibilityVerdict; note: string; entry: MatrixEntry | null } {
    const matching = this.entries.filter(
      (entry) =>
        entry.subject === subject &&
        entry.id === id &&
        satisfies(subjectVersion, entry.subjectRange) &&
        satisfies(frameworkVersion, entry.frameworkRange),
    );

    if (matching.length === 0) {
      return {
        verdict: 'unknown',
        note:
          `No recorded result for ${subject} "${id}" ${subjectVersion} on framework ` +
          `${frameworkVersion}. Untested is not the same as broken — but it is not the same as ` +
          'working either.',
        entry: null,
      };
    }

    const incompatible = matching.find((entry) => entry.verdict === 'incompatible');
    const chosen = incompatible ?? matching[0]!;

    return { verdict: chosen.verdict, note: chosen.note, entry: chosen };
  }

  /** Every entry for one subject, newest range first. Used by `trustos platform compatibility`. */
  forId(subject: CompatibilitySubject, id: string): MatrixEntry[] {
    return this.entries
      .filter((entry) => entry.subject === subject && entry.id === id)
      .sort((a, b) =>
        compareVersions(
          b.subjectRange.replace(/^[\^~>=]+/, ''),
          a.subjectRange.replace(/^[\^~>=]+/, ''),
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Upgrade recommendation

export const UPGRADE_URGENCIES = ['none', 'optional', 'recommended', 'required'] as const;
export type UpgradeUrgency = (typeof UPGRADE_URGENCIES)[number];

export interface UpgradeRecommendation {
  from: string;
  to: string | null;
  urgency: UpgradeUrgency;
  breaking: boolean;
  change: ReturnType<typeof versionChange>;
  /** Every reason, so the caller can show all of them rather than the first. */
  reasons: string[];
}

/**
 * What to upgrade to, and how urgently.
 *
 * Recommends the highest available version, and separately reports whether reaching it is
 * breaking. Those are two facts and they are often confused: "there is a new major" is not a
 * reason to stay, and "the upgrade is breaking" is not a reason to go.
 *
 * `required` is reserved for a version whose predecessor is out of support or carries a known
 * security fix. Everything else is `recommended` at most, because an upgrade a team is told they
 * must do, for no stated reason, is an upgrade they learn to ignore.
 */
export function recommendUpgrade(options: {
  current: string;
  available: readonly string[];
  /** Versions that fix a security issue. Reaching or passing one makes the upgrade required. */
  securityFixes?: readonly string[];
  /** True when the current version is out of support. */
  outOfSupport?: boolean;
  /** Include prereleases. Off by default: a stable deployment should not be offered an rc. */
  includePrereleases?: boolean;
}): UpgradeRecommendation {
  const { current, available, securityFixes = [], outOfSupport = false } = options;

  const candidates = available
    .filter((version) => compareVersions(version, current) > 0)
    .filter((version) => options.includePrereleases || !version.includes('-'));

  if (candidates.length === 0) {
    return {
      from: current,
      to: null,
      urgency: outOfSupport ? 'required' : 'none',
      breaking: false,
      change: null,
      reasons: outOfSupport
        ? [`${current} is out of support and there is nothing newer to move to.`]
        : ['Already on the newest available version.'],
    };
  }

  const target = candidates.reduce((best, candidate) =>
    compareVersions(candidate, best) > 0 ? candidate : best,
  );

  const reasons: string[] = [];
  let urgency: UpgradeUrgency = 'optional';

  const relevantFixes = securityFixes.filter(
    (fix) => compareVersions(fix, current) > 0 && compareVersions(fix, target) <= 0,
  );

  if (relevantFixes.length > 0) {
    urgency = 'required';
    reasons.push(
      `Security fixes in ${relevantFixes.sort(compareVersions).join(', ')} are not in ${current}.`,
    );
  }

  if (outOfSupport) {
    urgency = 'required';
    reasons.push(`${current} is out of support.`);
  }

  const change = versionChange(current, target);

  if (urgency !== 'required' && (change === 'minor' || change === 'major')) {
    urgency = 'recommended';
    reasons.push(`${target} is a ${change} release ahead of ${current}.`);
  }

  if (reasons.length === 0) reasons.push(`${target} is available.`);

  const breaking = isBreakingChange(current, target);

  if (breaking) {
    reasons.push(
      `Moving to ${target} is a breaking change; read the migration notes before starting.`,
    );
  }

  return { from: current, to: target, urgency, breaking, change, reasons };
}

/**
 * Refuses an upgrade that goes backwards.
 *
 * Downgrades are not supported and pretending otherwise is worse than refusing: migrations run
 * forward, and a schema migrated to 0.4 does not un-migrate by installing 0.3. Rollback is a
 * *restore*, which `@trustos/upgrade-manager` handles from a backup.
 */
export function assertForwardUpgrade(from: string, to: string): void {
  if (compareVersions(to, from) > 0) return;

  throw ApiError.validation(
    [
      {
        path: 'to',
        message:
          `Cannot upgrade from ${from} to ${to}. Migrations run forward only — a schema migrated ` +
          'to a newer version does not un-migrate by installing an older one. To go back, restore ' +
          'the backup taken before the upgrade.',
        code: 'downgrade_refused',
      },
    ],
    'Downgrade refused.',
  );
}
