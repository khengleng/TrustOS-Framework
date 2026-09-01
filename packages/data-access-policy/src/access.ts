import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import {
  DATA_CLASSIFICATION_LEVELS,
  classificationRank,
  type DataClassificationLevel,
} from '@trustsystem/data-classification';
import type { DataCatalog } from '@trustsystem/data-catalog';

/**
 * Who may reach governed data, for what purpose, and the review that proves it.
 *
 * Two ideas, and the second is the one that decays.
 *
 * **Access is granted for a purpose.** Not to a person, not to a role — to a role *for a stated
 * purpose*, against data whose catalog entry states its own purpose. `purposeCompatible` refuses
 * a grant whose purpose does not match the data's, which is what stops a marketing analytics
 * grant from quietly covering the fraud investigation table because both are "analytics".
 *
 * **A grant that is never reviewed is a grant forever.** Access accumulates: somebody joins a
 * team, gets access, moves teams, keeps it. Nobody removes access, because removing it might
 * break something and nobody is sure. So grants **expire**, and a review is the thing that
 * renews them — `certify` extends, `revoke` ends, and doing nothing ends it too.
 *
 * That last property is the whole design. An access review where doing nothing preserves the
 * status quo is an access review that gets skipped, and the skipping is invisible.
 */

export const ACCESS_PURPOSES = [
  'service_operation',
  'customer_support',
  'fraud_investigation',
  'regulatory_reporting',
  'financial_reporting',
  'product_analytics',
  'incident_response',
  'audit',
  'model_training',
] as const;

export type AccessPurpose = (typeof ACCESS_PURPOSES)[number];

/**
 * Which purposes may reach which classifications.
 *
 * `model_training` tops out at `INTERNAL`, which is the entry worth arguing about and the one
 * that should stay. Training on customer data is not impossible — it is a decision with a lawful
 * basis, a consent position and a retention consequence, and it is made by a person for a
 * specific dataset rather than inherited from a general-purpose grant.
 */
export const PURPOSE_CEILINGS: Readonly<Record<AccessPurpose, DataClassificationLevel>> = {
  service_operation: 'HIGHLY_RESTRICTED',
  incident_response: 'HIGHLY_RESTRICTED',
  audit: 'HIGHLY_RESTRICTED',
  fraud_investigation: 'RESTRICTED',
  regulatory_reporting: 'RESTRICTED',
  financial_reporting: 'RESTRICTED',
  customer_support: 'CONFIDENTIAL',
  product_analytics: 'INTERNAL',
  model_training: 'INTERNAL',
};

export const accessGrantSchema = z
  .object({
    grantId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
    /** What is being reached. A catalog entry, always — ungoverned data is not grantable. */
    entryId: z.string().min(1).max(120),
    /** Who. A role or a service account, never an individual — individuals move teams. */
    principal: z.string().min(1).max(120),
    principalKind: z.enum(['role', 'service_account', 'api_consumer']),
    purpose: z.enum(ACCESS_PURPOSES),
    /** What they may do. */
    operations: z.array(z.enum(['read', 'aggregate', 'export'])).min(1),
    /** Whether the grant sees unmasked values. Separate from reading at all. */
    unmasked: z.boolean().default(false),

    grantedBy: z.string().min(1).max(80),
    grantedAt: z.string().datetime(),
    /**
     * When it ends.
     *
     * Required, and bounded. A grant with no expiry is a grant forever, and access accumulates
     * because removing it might break something and nobody is sure.
     */
    expiresAt: z.string().datetime(),
    justification: z.string().min(20).max(1000),
  })
  .strict();

export type AccessGrant = z.infer<typeof accessGrantSchema>;

/** The longest a grant may run before somebody re-confirms it. */
export const MAX_GRANT_DAYS = 365;

export function assertGrantBounded(grant: AccessGrant): void {
  const days =
    (new Date(grant.expiresAt).getTime() - new Date(grant.grantedAt).getTime()) / 86_400_000;

  if (days > MAX_GRANT_DAYS) {
    throw new ApiError('validation_error', {
      message:
        `A grant may run at most ${MAX_GRANT_DAYS} days before it is re-confirmed. This one runs ` +
        `${Math.round(days)}. A longer grant is a permanent one with a date on it.`,
      context: { grantId: grant.grantId },
    });
  }

  if (days <= 0) {
    throw new ApiError('validation_error', {
      message: 'A grant that expires before it starts grants nothing.',
      context: { grantId: grant.grantId },
    });
  }
}

/** Whether a purpose may reach a classification at all. */
export function purposeCompatible(
  purpose: AccessPurpose,
  classification: DataClassificationLevel,
): boolean {
  return classificationRank(classification) <= classificationRank(PURPOSE_CEILINGS[purpose]);
}

export interface AccessDecision {
  allowed: boolean;
  reasons: string[];
  /** Whether the caller sees unmasked values, which is narrower than being allowed to read. */
  unmasked: boolean;
}

/**
 * Whether a grant permits an operation now.
 *
 * Every refusal is collected rather than the first returned, because a person told their grant
 * expired, then told the purpose is wrong, then told they cannot export, stops trusting the
 * answers.
 */
export function decideAccess(input: {
  grant: AccessGrant;
  catalog: DataCatalog;
  operation: 'read' | 'aggregate' | 'export';
  now: Date;
}): AccessDecision {
  const reasons: string[] = [];
  const entry = input.catalog.require(input.grant.entryId);
  const classification = input.catalog.inheritedClassification(entry.entryId);

  if (new Date(input.grant.expiresAt) <= input.now) {
    reasons.push(`The grant expired on ${input.grant.expiresAt}.`);
  }

  if (!input.grant.operations.includes(input.operation)) {
    reasons.push(`The grant permits ${input.grant.operations.join(', ')}, not ${input.operation}.`);
  }

  if (!purposeCompatible(input.grant.purpose, classification)) {
    reasons.push(
      `A "${input.grant.purpose}" grant may reach at most ${PURPOSE_CEILINGS[input.grant.purpose]} ` +
        `data, and this is ${classification}.`,
    );
  }

  /*
   * The data's own stated purpose, against the grant's.
   *
   * Both are declared, and the catalog's is the one written when the data was created — before
   * anybody wanted this particular access. Comparing them is what stops a general analytics grant
   * from covering a fraud investigation table because both words contain "analysis".
   */
  if (entry.purpose && input.grant.purpose === 'model_training' && entry.personalData) {
    reasons.push(
      'Training on personal data is a decision with a lawful basis, a consent position and a ' +
        'retention consequence. It is made for a specific dataset, not inherited from a grant.',
    );
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    unmasked: reasons.length === 0 && input.grant.unmasked,
  };
}

// --- access review ----------------------------------------------------------

export const REVIEW_OUTCOMES = ['certify', 'reduce', 'revoke', 'escalate'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export const accessReviewSchema = z
  .object({
    reviewId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
    grantId: z.string().min(1).max(80),
    reviewer: z.string().min(1).max(80),
    outcome: z.enum(REVIEW_OUTCOMES),
    /** Required for anything but a plain certification. */
    notes: z.string().max(1000).optional(),
    /** For `reduce`: the operations the grant keeps. */
    reducedTo: z
      .array(z.enum(['read', 'aggregate', 'export']))
      .max(3)
      .optional(),
    reviewedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (review.outcome === 'reduce' && (review.reducedTo ?? []).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reducedTo'],
        message: 'A reduction names what is kept. Reducing to nothing is a revocation.',
      });
    }

    if (review.outcome !== 'certify' && (review.notes ?? '').trim().length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notes'],
        message:
          'Anything but a plain certification needs a note. The person losing access asks why, ' +
          'and "the review said so" is not an answer.',
      });
    }
  });

export type AccessReview = z.infer<typeof accessReviewSchema>;

export interface ReviewCampaign {
  campaignId: string;
  /** Grants in scope, and whether each has been reviewed. */
  grants: Array<{ grantId: string; principal: string; entryId: string; reviewed: boolean }>;
  dueBy: Date;
}

/**
 * Applies a review to a grant.
 *
 * `certify` extends the grant by its original duration; `reduce` narrows it; `revoke` ends it
 * now. There is no outcome that extends it indefinitely.
 */
export function applyReview(
  grant: AccessGrant,
  review: AccessReview,
  now: Date,
): AccessGrant | null {
  switch (review.outcome) {
    case 'revoke':
      return null;

    case 'certify':
      return accessGrantSchema.parse({
        ...grant,
        grantedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + MAX_GRANT_DAYS * 86_400_000).toISOString(),
      });

    case 'reduce':
      return accessGrantSchema.parse({
        ...grant,
        operations: review.reducedTo ?? grant.operations,
        /* Reducing does not extend. The clock keeps running. */
        unmasked: false,
      });

    case 'escalate':
      /*
       * Escalation leaves the grant exactly as it is.
       *
       * Deliberately: an escalation means the reviewer could not decide, and the safe reading of
       * "could not decide" is not "extend for another year". The grant continues to its original
       * expiry and lapses if nobody resolves it.
       */
      return grant;
  }
}

/**
 * Grants that will lapse because nobody reviewed them.
 *
 * The report an access review campaign closes with — and the reason the default is expiry rather
 * than continuation. A campaign where doing nothing preserves the status quo is a campaign that
 * gets skipped, and the skipping is invisible.
 */
export function lapsingGrants(
  grants: readonly AccessGrant[],
  reviews: readonly AccessReview[],
  now: Date,
  withinDays = 30,
): AccessGrant[] {
  const reviewed = new Set(reviews.map((review) => review.grantId));
  const horizon = new Date(now.getTime() + withinDays * 86_400_000);

  return grants.filter(
    (grant) => !reviewed.has(grant.grantId) && new Date(grant.expiresAt) <= horizon,
  );
}

/** What a campaign covers: every grant reaching data at or above a classification. */
export function campaignScope(
  grants: readonly AccessGrant[],
  catalog: DataCatalog,
  atOrAbove: DataClassificationLevel,
): AccessGrant[] {
  return grants.filter((grant) => {
    const entry = catalog.find(grant.entryId);
    if (!entry) return false;

    return (
      classificationRank(catalog.inheritedClassification(entry.entryId)) >=
      classificationRank(atOrAbove)
    );
  });
}

export { DATA_CLASSIFICATION_LEVELS };
