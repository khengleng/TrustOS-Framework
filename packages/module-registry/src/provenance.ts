import { z } from 'zod';
import { moduleIdSchema } from '@trustsystem/module-sdk';

/**
 * Who made a module, under what licence, and how good it is.
 *
 * Kept beside the catalog rather than inside `moduleMetadataSchema` because these are facts about
 * the *distribution* of a module, not about the module itself. A module's permissions and routes
 * are the same wherever it came from; its quality score is a judgement the platform makes and can
 * revise without touching the module.
 *
 * The scores are the part worth being careful about.
 *
 * A score is a **summary of checks that were run**, never an opinion. `securityScore` counts the
 * security-relevant gates the module passed; `qualityScore` counts coverage, documentation and
 * lint. Both carry the checks they were derived from, so a reader can disagree with the weighting
 * and recompute. A bare number nobody can decompose is a number people either trust blindly or
 * ignore entirely, and both are bad.
 *
 * There is no user rating in the score. Ratings are recorded separately and shown separately —
 * mixing "eleven people liked it" with "it passed the security gates" produces a number that
 * means neither.
 */

export const MODULE_STATUSES = ['experimental', 'stable', 'deprecated', 'withdrawn'] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];

export const scoreComponentSchema = z
  .object({
    check: z.string().min(1).max(80),
    passed: z.boolean(),
    weight: z.number().int().min(1).max(10),
    detail: z.string().max(300).default(''),
  })
  .strict();

export type ScoreComponent = z.infer<typeof scoreComponentSchema>;

export const moduleProvenanceSchema = z
  .object({
    moduleId: moduleIdSchema,
    /** A person or team who can be asked. Not a company name. */
    author: z.string().min(1).max(120),
    authorContact: z.string().max(200).default(''),
    license: z.string().min(1).max(60),
    status: z.enum(MODULE_STATUSES).default('experimental'),
    /** Required once withdrawn or deprecated: where to go instead. */
    supersededBy: moduleIdSchema.optional(),
    documentation: z.string().min(1).max(200).default('docs/modules.md'),
    /** The checks behind the two scores. Empty means unscored, which is not the same as zero. */
    securityChecks: z.array(scoreComponentSchema).default([]),
    qualityChecks: z.array(scoreComponentSchema).default([]),
    /** Key id that signed the published artefact, when there is one. */
    signedBy: z.string().max(80).nullable().default(null),
    /** User ratings, 1–5. Shown beside the scores, never folded into them. */
    ratings: z.array(z.number().int().min(1).max(5)).default([]),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.status === 'deprecated' || entry.status === 'withdrawn') && !entry.supersededBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message:
          `A ${entry.status} module must name its successor. A notice with nowhere to go leaves ` +
          'the reader on the module they were told to leave.',
      });
    }
  });

export type ModuleProvenance = z.infer<typeof moduleProvenanceSchema>;

/**
 * A score out of 100, or null when nothing has been checked.
 *
 * Null rather than zero. Zero says "it failed everything"; null says "nobody looked", and those
 * lead to opposite decisions.
 */
export function scoreOf(checks: readonly ScoreComponent[]): number | null {
  if (checks.length === 0) return null;

  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0);

  return Math.round((earned / total) * 100);
}

export const securityScore = (entry: ModuleProvenance): number | null =>
  scoreOf(entry.securityChecks);
export const qualityScore = (entry: ModuleProvenance): number | null =>
  scoreOf(entry.qualityChecks);

/** The checks that failed, so a low score can be acted on rather than argued with. */
export function failedChecks(entry: ModuleProvenance): ScoreComponent[] {
  return [...entry.securityChecks, ...entry.qualityChecks].filter((check) => !check.passed);
}

/** Mean rating to one decimal, or null when nobody has rated it. */
export function averageRating(entry: ModuleProvenance): number | null {
  if (entry.ratings.length === 0) return null;

  const total = entry.ratings.reduce((sum, rating) => sum + rating, 0);
  return Math.round((total / entry.ratings.length) * 10) / 10;
}

/**
 * Whether a module should be installable without an explicit override.
 *
 * A withdrawn module is not — it was pulled for a reason, and the reason is usually a
 * vulnerability. A deprecated one still installs: something already depends on it, and blocking
 * the install turns an upgrade into a rewrite.
 */
export function isInstallable(entry: ModuleProvenance): boolean {
  return entry.status !== 'withdrawn';
}
