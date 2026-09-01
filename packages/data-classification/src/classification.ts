import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';

/**
 * The data classification model.
 *
 * Five levels. The value of a classification is not the label — it is that **each level obliges
 * something specific**, and the obligations are data rather than prose. A classification scheme
 * whose levels only differ in name is a scheme where everything is eventually `internal`, because
 * nothing follows from choosing anything else.
 *
 * So each level below carries: whether it must be masked, whether it may be exported, how long it
 * is kept by default, whether it may leave its residency region, and what a reveal costs. Those
 * are the fields other packages read — `data-retention` for deletion, `data-masking` for display,
 * `governance-export-control` for ceilings — so a level change propagates rather than sitting in
 * a spreadsheet.
 *
 * `HIGHLY_RESTRICTED` is not "restricted, but more". It is the level where the default is that
 * data **does not leave the system**: no export, no cross-region replication, no reveal without a
 * second person. A deployment that finds itself wanting to export it has usually classified
 * something wrongly, and that conversation is the point.
 */

export const DATA_CLASSIFICATION_LEVELS = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
  'HIGHLY_RESTRICTED',
] as const;

export type DataClassificationLevel = (typeof DATA_CLASSIFICATION_LEVELS)[number];

export interface ClassificationObligations {
  level: DataClassificationLevel;
  description: string;
  /** Whether a value must be masked before it reaches a person who has not asked for it. */
  maskByDefault: boolean;
  /** Whether it may be exported at all. */
  exportable: boolean;
  /** Whether a reveal needs a second person. */
  revealRequiresApproval: boolean;
  /** Whether it may be replicated outside its residency region. */
  crossRegionPermitted: boolean;
  /** Default retention, in days. A starting point a jurisdiction overrides. */
  defaultRetentionDays: number;
  /** How often somebody must confirm the classification is still right. */
  reviewIntervalDays: number;
  /** Whether an AI feature may be given it as an input. */
  aiInputPermitted: boolean;
}

/**
 * What each level obliges.
 *
 * Ordered from least to most restrictive, and every field descends monotonically — which is
 * checked by a test, because a table where `RESTRICTED` is somehow more permissive than
 * `CONFIDENTIAL` in one column is a table that produces exactly one wrong decision and nobody
 * notices which.
 */
export const CLASSIFICATION_OBLIGATIONS: Readonly<
  Record<DataClassificationLevel, ClassificationObligations>
> = Object.freeze({
  PUBLIC: {
    level: 'PUBLIC',
    description:
      'Published, or publishable. Product documentation, rate cards, open reference data.',
    maskByDefault: false,
    exportable: true,
    revealRequiresApproval: false,
    crossRegionPermitted: true,
    defaultRetentionDays: 3650,
    reviewIntervalDays: 730,
    aiInputPermitted: true,
  },
  INTERNAL: {
    level: 'INTERNAL',
    description: 'Ordinary business data. Harmful to publish, not harmful to circulate internally.',
    maskByDefault: false,
    exportable: true,
    revealRequiresApproval: false,
    crossRegionPermitted: true,
    defaultRetentionDays: 2555,
    reviewIntervalDays: 365,
    aiInputPermitted: true,
  },
  CONFIDENTIAL: {
    level: 'CONFIDENTIAL',
    description: 'Customer and merchant records. Circulated on need, masked by default.',
    maskByDefault: true,
    exportable: true,
    revealRequiresApproval: false,
    crossRegionPermitted: true,
    defaultRetentionDays: 2555,
    reviewIntervalDays: 365,
    aiInputPermitted: true,
  },
  RESTRICTED: {
    level: 'RESTRICTED',
    description: 'Wallets, transactions, positions. Masked, exportable only under approval.',
    maskByDefault: true,
    exportable: true,
    revealRequiresApproval: true,
    crossRegionPermitted: false,
    defaultRetentionDays: 2555,
    reviewIntervalDays: 180,
    aiInputPermitted: true,
  },
  HIGHLY_RESTRICTED: {
    level: 'HIGHLY_RESTRICTED',
    description:
      'The ledger and the audit trail. The default is that it does not leave the system: no ' +
      'export, no cross-region replication, no reveal without a second person, no AI input.',
    maskByDefault: true,
    exportable: false,
    revealRequiresApproval: true,
    crossRegionPermitted: false,
    defaultRetentionDays: 3650,
    reviewIntervalDays: 90,
    aiInputPermitted: false,
  },
});

export function obligationsFor(level: DataClassificationLevel): ClassificationObligations {
  return CLASSIFICATION_OBLIGATIONS[level];
}

/** Rank, so two levels can be compared. Higher is more restrictive. */
export function classificationRank(level: DataClassificationLevel): number {
  return DATA_CLASSIFICATION_LEVELS.indexOf(level);
}

/**
 * The stricter of two levels.
 *
 * Used wherever data of different classifications meets — a report joining two tables, an export
 * spanning several columns, a lineage edge. **The result takes the highest classification of its
 * inputs**, always, and never an average or the destination's own.
 *
 * That rule is the single most load-bearing function in data governance. A report that joined a
 * public table to a restricted one and inherited "public" would be a restricted extract with a
 * public label on it, and every downstream control would then be the wrong one.
 */
export function combineClassifications(
  ...levels: readonly DataClassificationLevel[]
): DataClassificationLevel {
  if (levels.length === 0) return 'INTERNAL';

  return levels.reduce((highest, level) =>
    classificationRank(level) > classificationRank(highest) ? level : highest,
  );
}

/**
 * Organization-specific extensions.
 *
 * A deployment may add levels *between* the five, never outside them — a level above
 * `HIGHLY_RESTRICTED` would be a level with no obligations defined for it, and a level below
 * `PUBLIC` is not a thing. `insertAfter` names the standard level it sits above.
 */
export const classificationExtensionSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/),
    label: z.string().min(1).max(80),
    description: z.string().min(10).max(400),
    insertAfter: z.enum(DATA_CLASSIFICATION_LEVELS),
    /** Obligations. Must be at least as strict as the level it sits above. */
    obligations: z
      .object({
        maskByDefault: z.boolean(),
        exportable: z.boolean(),
        revealRequiresApproval: z.boolean(),
        crossRegionPermitted: z.boolean(),
        defaultRetentionDays: z.number().int().min(1).max(36_500),
        reviewIntervalDays: z.number().int().min(1).max(1095),
        aiInputPermitted: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((extension, ctx) => {
    const base = CLASSIFICATION_OBLIGATIONS[extension.insertAfter];
    const stricter = extension.obligations;

    const loosened: string[] = [];
    if (base.maskByDefault && !stricter.maskByDefault) loosened.push('maskByDefault');
    if (!base.exportable && stricter.exportable) loosened.push('exportable');
    if (base.revealRequiresApproval && !stricter.revealRequiresApproval) {
      loosened.push('revealRequiresApproval');
    }
    if (!base.crossRegionPermitted && stricter.crossRegionPermitted)
      loosened.push('crossRegionPermitted');
    if (!base.aiInputPermitted && stricter.aiInputPermitted) loosened.push('aiInputPermitted');

    if (loosened.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['obligations'],
        message:
          `An extension above ${extension.insertAfter} loosens ${loosened.join(', ')}. A level ` +
          'that sits higher and obliges less is a level people use to get out of an obligation.',
      });
    }
  });

export type ClassificationExtension = z.infer<typeof classificationExtensionSchema>;

/** Refuses an operation the classification does not permit. */
export function assertPermitted(
  level: DataClassificationLevel,
  operation: 'export' | 'cross_region' | 'ai_input',
): void {
  const obligations = obligationsFor(level);

  const permitted =
    operation === 'export'
      ? obligations.exportable
      : operation === 'cross_region'
        ? obligations.crossRegionPermitted
        : obligations.aiInputPermitted;

  if (permitted) return;

  throw new ApiError('forbidden', {
    message:
      `${level} data may not be used for "${operation}". ${obligations.description} If this ` +
      'operation is genuinely needed, the classification is probably wrong — and that is the ' +
      'conversation worth having rather than an exception.',
    context: { classification: level, operation },
  });
}
