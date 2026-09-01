import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import {
  DATA_CLASSIFICATION_LEVELS,
  obligationsFor,
  type DataClassificationLevel,
} from '@trustsystem/data-classification';

/**
 * Retention, archival, legal hold and deletion.
 *
 * One rule dominates everything else in this file: **a legal hold always wins.** Not usually, not
 * unless the retention period has expired, not unless somebody with enough authority overrides
 * it. `assertDeletable` refuses while a hold is open, and there is no parameter that skips it.
 *
 * The reason it is stated that absolutely: automated deletion is the one data-governance control
 * that destroys evidence, and it runs unattended. Every other control here fails safe by refusing;
 * this one fails by deleting something that was needed, which cannot be undone and is usually
 * discovered by a regulator.
 *
 * The second rule: **the longest applicable retention applies.** A record covered by three rules
 * — a jurisdiction's seven years, a product's five, a classification's default of three — is kept
 * for seven. Taking the shortest, or the most specific, is how a record required by law is
 * deleted on schedule by a system doing exactly what it was told.
 */

export const RETENTION_ACTIONS = ['delete', 'anonymize', 'archive', 'review_then_delete'] as const;

export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export const retentionRuleSchema = z
  .object({
    ruleId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
    description: z.string().min(10).max(400),

    /** What the rule covers. Any subset; an empty selector matches everything at that dimension. */
    appliesTo: z
      .object({
        classification: z.enum(DATA_CLASSIFICATION_LEVELS).optional(),
        recordType: z.string().max(80).optional(),
        country: z.string().max(40).optional(),
        productId: z.string().max(80).optional(),
        organizationId: z.string().max(80).optional(),
        personalData: z.boolean().optional(),
      })
      .strict(),

    /** Below this, nothing may delete it — including a subject's erasure request. */
    minimumRetentionDays: z.number().int().min(0).max(36_500),
    /** After this, it must be dealt with. */
    maximumRetentionDays: z.number().int().min(1).max(36_500),
    /** What happens when the maximum is reached. */
    action: z.enum(RETENTION_ACTIONS),

    /** The obligation this rule implements. Named, because "why do we keep this" is asked. */
    legalBasis: z.string().min(5).max(200),
    /** Whether a person confirms before the action runs. */
    requiresReview: z.boolean().default(false),

    effectiveFrom: z.string().datetime(),
    reviewDate: z.string().datetime(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.minimumRetentionDays > rule.maximumRetentionDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maximumRetentionDays'],
        message:
          'The minimum is above the maximum, so this record must be both kept and deleted. One ' +
          'of the two obligations is wrong and guessing which is not this package’s job.',
      });
    }

    if (rule.action === 'delete' && rule.minimumRetentionDays === 0 && !rule.requiresReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresReview'],
        message:
          'A rule that deletes with no minimum retention and no review is an unattended process ' +
          'that can destroy a record the day it is created.',
      });
    }
  });

export type RetentionRule = z.infer<typeof retentionRuleSchema>;

export interface RecordFacts {
  recordType: string;
  classification: DataClassificationLevel;
  country?: string;
  productId?: string;
  organizationId?: string;
  personalData: boolean;
  createdAt: Date;
}

export interface RetentionDecision {
  /** Every rule that matched, most restrictive first. */
  applicable: RetentionRule[];
  /** The longest minimum across matching rules. Nothing may delete before this. */
  minimumRetentionDays: number;
  /** The longest maximum. The record is dealt with then, not earlier. */
  maximumRetentionDays: number;
  action: RetentionAction;
  requiresReview: boolean;
  deletableFrom: Date;
  dueBy: Date;
  /** Named so "why are we keeping this" has an answer. */
  legalBases: string[];
}

/**
 * Which rules apply, and what they add up to.
 *
 * The **longest** minimum and the **longest** maximum, across every matching rule. Not the most
 * specific rule, and not the first match: a record covered by a jurisdiction's seven years and a
 * product's five is kept for seven, and a system that took the most specific rule would delete it
 * two years early while doing exactly what it was told.
 */
export function decideRetention(
  rules: readonly RetentionRule[],
  facts: RecordFacts,
): RetentionDecision {
  const applicable = rules.filter((rule) => matches(rule, facts));

  if (applicable.length === 0) {
    /*
     * No rule is not "keep forever" and not "delete now" — it is the classification's default,
     * and it is reported as such so an absent rule is visible rather than silently permissive.
     */
    const obligations = obligationsFor(facts.classification);

    return {
      applicable: [],
      minimumRetentionDays: 0,
      maximumRetentionDays: obligations.defaultRetentionDays,
      action: 'review_then_delete',
      requiresReview: true,
      deletableFrom: facts.createdAt,
      dueBy: addDays(facts.createdAt, obligations.defaultRetentionDays),
      legalBases: [`No rule matched; the ${facts.classification} default applies.`],
    };
  }

  const minimumRetentionDays = Math.max(...applicable.map((rule) => rule.minimumRetentionDays));
  const maximumRetentionDays = Math.max(...applicable.map((rule) => rule.maximumRetentionDays));

  /*
   * The gentlest action among the rules that reach the longest maximum.
   *
   * If one rule says delete and another says anonymize at the same horizon, anonymizing satisfies
   * both — the data is gone for the purpose the deleting rule cared about, and the record still
   * exists for the one that wanted it kept.
   */
  const atHorizon = applicable.filter((rule) => rule.maximumRetentionDays === maximumRetentionDays);
  const action = gentlest(atHorizon.map((rule) => rule.action));

  return {
    applicable: [...applicable].sort(
      (left, right) => right.maximumRetentionDays - left.maximumRetentionDays,
    ),
    minimumRetentionDays,
    maximumRetentionDays,
    action,
    requiresReview: applicable.some((rule) => rule.requiresReview),
    deletableFrom: addDays(facts.createdAt, minimumRetentionDays),
    dueBy: addDays(facts.createdAt, maximumRetentionDays),
    legalBases: [...new Set(applicable.map((rule) => rule.legalBasis))].sort(),
  };
}

function matches(rule: RetentionRule, facts: RecordFacts): boolean {
  const selector = rule.appliesTo;

  if (selector.classification && selector.classification !== facts.classification) return false;
  if (selector.recordType && selector.recordType !== facts.recordType) return false;
  if (selector.country && selector.country !== facts.country) return false;
  if (selector.productId && selector.productId !== facts.productId) return false;
  if (selector.organizationId && selector.organizationId !== facts.organizationId) return false;
  if (selector.personalData !== undefined && selector.personalData !== facts.personalData)
    return false;

  return true;
}

const ACTION_SEVERITY: Record<RetentionAction, number> = {
  archive: 0,
  review_then_delete: 1,
  anonymize: 2,
  delete: 3,
};

function gentlest(actions: readonly RetentionAction[]): RetentionAction {
  return actions.reduce((gentlestSoFar, action) =>
    ACTION_SEVERITY[action] < ACTION_SEVERITY[gentlestSoFar] ? action : gentlestSoFar,
  );
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

// --- legal hold -------------------------------------------------------------

export const legalHoldSchema = z
  .object({
    holdId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
    /** What it covers. Deliberately broad selectors — a hold that missed a record is not a hold. */
    scope: z
      .object({
        recordType: z.string().max(80).optional(),
        organizationId: z.string().max(80).optional(),
        subjectRef: z.string().max(120).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
      .strict(),
    reason: z.string().min(20).max(1000),
    /** Who placed it, and who may lift it. Never the same person by default. */
    placedBy: z.string().min(1).max(80),
    placedAt: z.string().datetime(),
    /** Null while the hold is open. A hold with no end is the normal case. */
    liftedAt: z.string().datetime().nullable(),
    liftedBy: z.string().max(80).nullable(),
  })
  .strict()
  .superRefine((hold, ctx) => {
    if (hold.liftedAt && !hold.liftedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['liftedBy'],
        message: 'A lifted hold records who lifted it.',
      });
    }

    if (hold.liftedBy && hold.liftedBy === hold.placedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['liftedBy'],
        message:
          'The person who placed the hold lifted it. A hold one person can place and remove is a ' +
          'note, not a hold.',
      });
    }
  });

export type LegalHold = z.infer<typeof legalHoldSchema>;

export function holdApplies(
  hold: LegalHold,
  facts: RecordFacts & { subjectRef?: string },
): boolean {
  if (hold.liftedAt !== null) return false;

  const scope = hold.scope;

  if (scope.recordType && scope.recordType !== facts.recordType) return false;
  if (scope.organizationId && scope.organizationId !== facts.organizationId) return false;
  if (scope.subjectRef && scope.subjectRef !== facts.subjectRef) return false;
  if (scope.from && facts.createdAt < new Date(scope.from)) return false;
  if (scope.to && facts.createdAt > new Date(scope.to)) return false;

  return true;
}

/**
 * Refuses a deletion.
 *
 * Three refusals, and the first one has no override. There is no `force`, no `override` and no
 * privileged caller — a hold that can be skipped by an argument is a hold that gets skipped by an
 * argument during exactly the incident it was placed for.
 */
export function assertDeletable(input: {
  facts: RecordFacts & { subjectRef?: string };
  decision: RetentionDecision;
  holds: readonly LegalHold[];
  now: Date;
  /** Whether a required review has been recorded. */
  reviewed?: boolean;
}): void {
  const active = input.holds.filter((hold) => holdApplies(hold, input.facts));

  if (active.length > 0) {
    throw new ApiError('forbidden', {
      message:
        `This record is under ${active.length} legal hold(s) and will not be deleted. ` +
        `${active.map((hold) => hold.holdId).join(', ')}. There is no override — a hold that ` +
        'can be skipped by an argument gets skipped during the incident it was placed for.',
      context: {
        holds: active.map((hold) => hold.holdId).join(','),
        recordType: input.facts.recordType,
      },
    });
  }

  if (input.now < input.decision.deletableFrom) {
    throw new ApiError('forbidden', {
      message:
        `This record must be kept until ${input.decision.deletableFrom.toISOString()} under: ` +
        `${input.decision.legalBases.join('; ')}.`,
      context: { deletableFrom: input.decision.deletableFrom.toISOString() },
    });
  }

  if (input.decision.requiresReview && !input.reviewed) {
    throw new ApiError('forbidden', {
      message: 'A rule covering this record requires a person to confirm before it is deleted.',
      context: { recordType: input.facts.recordType },
    });
  }
}

/** Records due for their retention action. What a scheduled sweep asks for. */
export function dueForAction(
  records: ReadonlyArray<RecordFacts & { recordId: string; subjectRef?: string }>,
  rules: readonly RetentionRule[],
  holds: readonly LegalHold[],
  now: Date,
): Array<{
  recordId: string;
  action: RetentionAction;
  dueBy: Date;
  blockedByHold: string[];
  requiresReview: boolean;
}> {
  return records
    .map((record) => {
      const decision = decideRetention(rules, record);
      const blocking = holds.filter((hold) => holdApplies(hold, record));

      return {
        recordId: record.recordId,
        action: decision.action,
        dueBy: decision.dueBy,
        blockedByHold: blocking.map((hold) => hold.holdId),
        requiresReview: decision.requiresReview,
      };
    })
    .filter((entry) => entry.dueBy <= now);
}
