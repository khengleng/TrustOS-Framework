import { conditionSchema, type WorkflowCondition } from '@trustos/workflow-definition';
import { z } from 'zod';

/**
 * The product rule shape, and the closed vocabulary of facts a rule may read.
 *
 * The condition side is **not written here**. It is `@trustos/workflow-definition`'s structured
 * predicate tree, imported whole. That package's header explains at length why a condition is a
 * tree and not an expression string — a condition is untrusted input that influences an
 * authorization outcome, and every convenient alternative is a code-execution primitive. All of
 * that reasoning applies here unchanged, and a second condition language in this repository would
 * be a second place to get it wrong.
 *
 * What this file adds is the *outcome* side, which workflow conditions do not have: a workflow
 * condition selects a path, and a product rule additionally sets a fee, imposes a limit, demands
 * a review or refuses a transaction. That is the part that moves money, so it is a closed union
 * of eight outcomes with a schema each — never a callback, never a name resolved at runtime.
 *
 * The facts are a closed list for the same reason the outcomes are. A rule that could read any
 * field of the execution context could read `context.actor.roles` and make the *caller* decide
 * the fee. The engine builds the fact map from the context explicitly, and a rule naming a fact
 * outside `RULE_FACTS` is refused at validation rather than evaluating to `undefined` — which
 * would silently make the rule never fire, and a rule that never fires is a control that is not
 * running.
 */

/**
 * Every fact a rule may read.
 *
 * Section 8 of the specification lists thirteen; this is those thirteen plus the four the runtime
 * cannot work without (`productId`, `variantId`, `blockKey`, `attemptNumber`).
 *
 * Monetary facts appear twice on purpose. `amount` is a **string** in the transaction currency,
 * because a JSON number goes through a double and a fee computed from a double disagrees with the
 * ledger once in ten thousand transactions. `amountMinorUnits` is the integer form, and it is the
 * one comparisons should use: `gt` on a string compares lexicographically, so `"9.00" > "10.00"`
 * is true and the enhanced-review threshold is silently wrong. The rules engine refuses a
 * numeric comparison against `amount` for exactly that reason.
 */
export const RULE_FACTS = [
  'amount',
  'amountMinorUnits',
  'currency',
  'country',
  'productId',
  'productType',
  'variantId',
  'customerType',
  'kycLevel',
  'merchantType',
  'merchantTier',
  'riskScore',
  'riskLevel',
  'transactionType',
  'channel',
  'providerAvailable',
  'dailyUsageMinorUnits',
  'monthlyUsageMinorUnits',
  'velocityCount',
  'hourOfDay',
  'dayOfWeek',
  'blockKey',
  'attemptNumber',
] as const;

export type RuleFact = (typeof RULE_FACTS)[number];

/** Facts whose value is a string that must never be compared with an ordering operator. */
export const NON_ORDERABLE_FACTS: ReadonlySet<string> = new Set([
  'amount',
  'currency',
  'country',
  'productId',
  'productType',
  'variantId',
  'customerType',
  'merchantType',
  'merchantTier',
  'transactionType',
  'channel',
  'blockKey',
  'riskLevel',
]);

export function isRuleFact(value: string): value is RuleFact {
  return (RULE_FACTS as readonly string[]).includes(value);
}

/**
 * The outcomes a rule may produce.
 *
 * Eight, closed, each with its own payload. Note what is absent: there is no `execute`, no
 * `call`, no `script` and no `set` that could write an arbitrary field of the execution context.
 * A rule may steer the runtime; it may not become it.
 */
export const RULE_OUTCOME_KINDS = [
  'require_review',
  'route',
  'set_fee',
  'set_limit',
  'select_provider',
  'deny',
  'tag',
  'set_risk_level',
] as const;

export type RuleOutcomeKind = (typeof RULE_OUTCOME_KINDS)[number];

/** A monetary literal inside a rule. A string, always. See the header. */
const ruleMoneySchema = z
  .object({
    /** Minor units as a decimal string of digits — `"200000"` is $2,000.00 in a 2-exponent currency. */
    minorUnits: z.string().regex(/^-?[0-9]{1,24}$/, 'An integer number of minor units, as a string.'),
    currency: z.string().min(3).max(8),
  })
  .strict();

/** A rate inside a rule. A string with an explicit scale — never 0.005 as a float. */
const ruleRateSchema = z
  .object({
    /** Basis points times 100, as a string. `"5000"` is 0.50%. */
    hundredthsOfBasisPoint: z
      .string()
      .regex(/^[0-9]{1,10}$/, 'A non-negative integer of hundredths of a basis point, as a string.'),
  })
  .strict();

/**
 * The outcome union.
 *
 * A discriminated union on `kind`, which is what makes an unknown outcome a parse failure naming
 * the field rather than a silently-ignored object. The cross-field checks — a flat fee needs an
 * amount, a percentage fee needs a rate — hang off the union rather than off each member,
 * because `z.discriminatedUnion` takes plain objects and a refined member is no longer one.
 */
export const ruleOutcomeSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('require_review'),
        /** Which approval level must look at it. A reference code, never free text. */
        level: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
        reason: z.string().min(1).max(200),
      })
      .strict(),
    z
      .object({
        kind: z.literal('route'),
        /** A block key in this product. Validated against the graph at composition time. */
        toBlock: z.string().min(1).max(60),
      })
      .strict(),
    z
      .object({
        kind: z.literal('set_fee'),
        feeCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
        basis: z.enum(['flat', 'percentage']),
        flat: ruleMoneySchema.optional(),
        rate: ruleRateSchema.optional(),
        cap: ruleMoneySchema.optional(),
        floor: ruleMoneySchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('set_limit'),
        limitCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
        amount: ruleMoneySchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('select_provider'),
        /** A provider *interface*, never a named vendor. See docs/provider-abstraction.md. */
        providerInterface: z.string().min(1).max(60),
        connectorId: z.string().min(1).max(80),
      })
      .strict(),
    z
      .object({
        kind: z.literal('deny'),
        reason: z.string().min(1).max(200),
        /** Stable code the channel can map to a message. Never the reason string itself. */
        code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal('tag'),
        tag: z.string().regex(/^[a-z][a-z0-9_.-]{0,39}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal('set_risk_level'),
        level: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
      })
      .strict(),
  ])
  .superRefine((outcome, ctx) => {
    if (outcome.kind !== 'set_fee') return;

    if (outcome.basis === 'flat' && !outcome.flat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flat'],
        message: 'A flat fee needs an amount. One without is a fee of nothing, charged.',
      });
    }
    if (outcome.basis === 'percentage' && !outcome.rate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rate'],
        message: 'A percentage fee needs a rate.',
      });
    }
    if (outcome.cap && outcome.floor && BigInt(outcome.cap.minorUnits) < BigInt(outcome.floor.minorUnits)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cap'],
        message: 'The cap is below the floor, so every fee is both too large and too small.',
      });
    }
  });

export type RuleOutcome = z.infer<typeof ruleOutcomeSchema>;

export const productRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,59}$/, 'Lowercase kebab-case.'),
    description: z.string().min(1).max(300),
    /**
     * Evaluation order. Lower runs first, and a lower-priority rule cannot overwrite a decision a
     * higher one already made — see the conflict resolution in `@trustos/financial-product-rules`.
     * Explicit rather than array order because array order changes when somebody sorts a JSON
     * file, and a fee that changes when a file is prettified is a fee nobody can defend.
     */
    priority: z.number().int().min(0).max(999),
    when: conditionSchema,
    then: z.array(ruleOutcomeSchema).min(1).max(8),
    /** Off without deleting. A deleted rule loses its history; a disabled one keeps it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ProductRule = z.infer<typeof productRuleSchema>;

/**
 * The condition type, re-exported under this layer's name.
 *
 * An alias rather than a copy. Anything that changes about the predicate tree changes in one
 * place — `@trustos/workflow-definition` — and this layer inherits it, including the next
 * hardening somebody adds to `readField`.
 */
export type ProductCondition = WorkflowCondition;
