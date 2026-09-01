import {
  RULE_FACTS,
  isRuleFact,
  type ProductExecutionContext,
  type RuleFact,
} from '@trustsystem/financial-product-core';

/**
 * Building the fact map.
 *
 * The engine never receives the execution context. It receives a **fact map built from it**, and
 * the map contains exactly the twenty-three names in `RULE_FACTS` and nothing else.
 *
 * That indirection is the control. A rule evaluating directly against the context could read
 * `actor.actorId` and price by customer, or `actor.organizationId` and price by tenant — both of
 * which are things a product might legitimately want and neither of which should arrive by a rule
 * author discovering that the field happened to be reachable. Adding a fact is a deliberate
 * change to this file and to `RULE_FACTS`, reviewed as one.
 *
 * The map is flat and its values are scalars. A nested value would let a condition path traverse
 * into it, and the condition language's own field pattern permits dots — so the flatness here is
 * what makes "the closed list is really closed" true rather than aspirational.
 */

export type RuleFacts = Partial<Record<RuleFact, string | number | boolean>>;

/**
 * The facts for one execution, at one block.
 *
 * `blockKey` and `attemptNumber` change as the execution proceeds, which is why this is called
 * per block rather than once: a rule that fires on the first attempt and not the third is a
 * legitimate rule, and it needs the attempt number to be current rather than captured at start.
 */
export function buildFacts(
  context: ProductExecutionContext,
  position: { blockKey?: string; attemptNumber?: number; providerAvailable?: boolean } = {},
): RuleFacts {
  const input = context.input;
  const startedAt = context.startedAt;

  const facts: RuleFacts = {
    productId: context.productId,
    ...(context.variantId ? { variantId: context.variantId } : {}),

    /*
     * Both forms of the amount, and they are not interchangeable.
     *
     * `amount` is the exact decimal string and it is what an audit record and an explanation
     * quote. `amountMinorUnits` is a number and it is what a comparison uses. A rule comparing
     * against `amount` with `gt` is refused at validation, because `"9.00" > "10.00"` is true
     * lexicographically and an enhanced-review threshold that is wrong only for two-digit
     * amounts is worse than one that is wrong for all of them.
     *
     * The number is safe here in a way it would not be in a ledger: it is a comparison operand,
     * never an operand of arithmetic that produces a stored amount, and Number.MAX_SAFE_INTEGER
     * in minor units is ninety trillion dollars.
     */
    ...(input.amountMinorUnits
      ? {
          amount: input.amountMinorUnits,
          amountMinorUnits: safeMinorUnits(input.amountMinorUnits),
        }
      : {}),

    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.country ? { country: input.country } : {}),
    ...(input.transactionType ? { transactionType: input.transactionType } : {}),
    ...(input.customerType ? { customerType: input.customerType } : {}),
    ...(input.merchantType ? { merchantType: input.merchantType } : {}),
    ...(input.merchantTier ? { merchantTier: input.merchantTier } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.kycLevel ? { kycLevel: input.kycLevel } : {}),

    ...(context.risk.score !== undefined ? { riskScore: context.risk.score } : {}),
    ...(context.risk.level ? { riskLevel: context.risk.level } : {}),

    dailyUsageMinorUnits: safeMinorUnits(context.usage.dailyUsageMinorUnits),
    monthlyUsageMinorUnits: safeMinorUnits(context.usage.monthlyUsageMinorUnits),
    velocityCount: context.usage.velocityCount,

    /*
     * The clock, read once at execution start rather than per rule.
     *
     * A rule set evaluated across a midnight boundary would otherwise see two different days
     * within one transaction, and the branch taken would depend on how long the previous block
     * took. Determinism means the same inputs give the same answer, and "what time is it" is an
     * input.
     */
    hourOfDay: startedAt.getUTCHours(),
    dayOfWeek: startedAt.getUTCDay(),

    ...(position.blockKey ? { blockKey: position.blockKey } : {}),
    ...(position.attemptNumber !== undefined ? { attemptNumber: position.attemptNumber } : {}),
    ...(position.providerAvailable !== undefined
      ? { providerAvailable: position.providerAvailable }
      : {}),
  };

  return facts;
}

/**
 * Minor units as a comparison operand.
 *
 * Clamped rather than thrown on, and the clamp is upward. A value beyond the safe integer range
 * is an amount no product handles, and the honest behaviour for a *threshold comparison* is "this
 * is above every threshold" — which `Number.MAX_SAFE_INTEGER` gives. Returning `Infinity` would
 * be the same answer with a value that serialises to `null` in the explanation trace.
 */
function safeMinorUnits(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(parsed, Number.MAX_SAFE_INTEGER);
}

/**
 * Facts a definition can be sure of before it runs.
 *
 * Used by the validator to warn about a rule that reads a fact this product never supplies — a
 * rule on a fact nobody sets is a branch never taken, which is a typo far more often than an
 * intention, and it fails as silence rather than as an error.
 */
export function factsSuppliedBy(input: {
  hasAmount: boolean;
  hasRisk: boolean;
  hasMerchant: boolean;
}): RuleFact[] {
  return RULE_FACTS.filter((fact) => {
    if (!input.hasAmount && (fact === 'amount' || fact === 'amountMinorUnits')) return false;
    if (!input.hasRisk && (fact === 'riskScore' || fact === 'riskLevel')) return false;
    if (!input.hasMerchant && (fact === 'merchantType' || fact === 'merchantTier')) return false;
    return true;
  });
}

/** Whether every field a condition reads is a declared fact. */
export function unknownFacts(fields: readonly string[]): string[] {
  return fields.filter((field) => !isRuleFact(field));
}
