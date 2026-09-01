import { z } from 'zod';
import {
  compliancePolicySchema,
  productFeeSchema,
  productLimitSchema,
  productRuleSchema,
  providerRequirementSchema,
  riskPolicySchema,
  settlementPolicySchema,
} from '@trustsystem/financial-product-core';

/**
 * Product variants.
 *
 * A variant is a **controlled override**, not a copy. The distinction is the entire point of the
 * package: copying a merchant wallet to make a Cambodia SME merchant wallet gives two documents
 * that are identical on the day they are written and quietly different a year later, and the
 * difference is discovered when one of them settles wrongly.
 *
 * So a variant carries no blocks and no transitions, and the schema has no field for either. That
 * is the control, and it is enforced by absence rather than by a check: **the workflow is not
 * overridable**. If a variant needs a different sequence of blocks, it is a different product —
 * because a variant that could change the order of a limit check and a debit could remove the
 * limit check, and nothing in a variant review would show it.
 *
 * What a variant may change is the eight things section 11 of the specification lists: fees,
 * limits, countries, currencies, settlement, compliance, risk, provider selection — plus rules,
 * which the specification implies and which is where most real variation lives.
 *
 * Two of the overrides are asymmetric on purpose, and both asymmetries are stated in `resolve.ts`
 * rather than here because they are resolution rules rather than shape rules:
 *
 *   * A variant may **narrow** the country and currency lists, never widen them. The base was
 *     approved for a set of jurisdictions; a variant adding one is a jurisdiction nobody reviewed.
 *   * A variant may not remove a base rule that **denies or demands review**. Removing a control
 *     through a variant is the bypass this whole layer exists to prevent, and it would arrive
 *     looking like a pricing change.
 */

export const variantOverridesSchema = z
  .object({
    fees: z.array(productFeeSchema).max(50).optional(),
    limits: z.array(productLimitSchema).max(50).optional(),
    supportedCountries: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/))
      .max(200)
      .optional(),
    supportedCurrencies: z.array(z.string().min(3).max(8)).max(50).optional(),
    settlementPolicy: settlementPolicySchema.optional(),
    compliancePolicy: compliancePolicySchema.optional(),
    riskPolicy: riskPolicySchema.optional(),
    /**
     * Which connector each interface binds to.
     *
     * The *interface* is fixed by the base product — a variant chooses a different connector for
     * `PaymentProvider`, never a different interface. Changing the interface would change which
     * block contract applies, which is a workflow change wearing a configuration hat.
     */
    providers: z.array(providerRequirementSchema).max(20).optional(),
    /** Rules merged by id. See `resolve.ts` for what a variant may not remove. */
    rules: z.array(productRuleSchema).max(200).optional(),
    /** Extra approval levels this variant demands on top of the base's. Never fewer. */
    additionalApprovalLevels: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/))
      .max(10)
      .optional(),
  })
  .strict();

export type VariantOverrides = z.infer<typeof variantOverridesSchema>;

/**
 * The paths a variant may override.
 *
 * Derived from the schema rather than written twice, so the list and the schema cannot disagree.
 * Exported because governance reads it to decide which approvals a variant change needs, and the
 * admin UI reads it to decide which panels to show.
 */
export const OVERRIDABLE_PATHS: readonly string[] = Object.keys(variantOverridesSchema.shape);

export const productVariantSchema = z
  .object({
    variantId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/, 'Lowercase kebab-case.'),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(400),

    baseProductId: z.string().min(1).max(80),
    /**
     * The exact base version. Not a range.
     *
     * A variant pinned to `2.x` would change when the base publishes 2.1 — silently, for every
     * merchant on that variant, with no approval recorded against the variant. Every version
     * binding in this layer is exact for the same reason.
     */
    baseVersion: z.string().regex(/^\d+\.\d+\.\d+$/),

    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    overrides: variantOverridesSchema,

    lifecycleStatus: z.enum(['draft', 'under_review', 'approved', 'active', 'paused', 'retired']),
    effectiveDate: z.string().datetime(),
    reviewDate: z.string().datetime(),
  })
  .strict()
  .superRefine((variant, ctx) => {
    if (Object.keys(variant.overrides).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overrides'],
        message:
          'A variant that overrides nothing is the base product with a second name, and it will ' +
          'be maintained as if it were something else.',
      });
    }

    if (new Date(variant.reviewDate) <= new Date(variant.effectiveDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewDate'],
        message: 'The review date must be after the effective date.',
      });
    }
  });

export type ProductVariant = z.infer<typeof productVariantSchema>;

export function parseVariant(input: unknown): ProductVariant {
  return productVariantSchema.parse(input);
}
