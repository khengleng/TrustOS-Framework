import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import {
  compareMoney,
  formatMoney,
  money,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';

/**
 * Financial policy.
 *
 * What a tenant is allowed to do with money: which currencies, whether a balance may go negative,
 * how long a settlement window is, above what value a transaction needs approval.
 *
 * Two decisions inherited from `@trustos/ai-policy`, for the same reasons:
 *
 *   1. **Policies are never merged.** The most specific one applies whole. Merging two produces a
 *      policy nobody wrote, and "why was this allowed" stops having an answer.
 *   2. **Default deny for the things that matter.** An unlisted currency is refused. A negative
 *      balance is refused. Both defaults are the safe direction, and both are overridable
 *      deliberately.
 */

export const financialPolicySchema = z
  .object({
    name: z.string().min(1).max(120),

    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('platform') }).strict(),
      z.object({ kind: z.literal('organization'), organizationId: z.string() }).strict(),
      z.object({ kind: z.literal('account_type'), accountType: z.string() }).strict(),
    ]),

    /**
     * Currencies this tenant may transact in.
     *
     * Empty means none, not all. A currency nobody configured produces balances nothing can report
     * on or settle, so the safe default is to refuse.
     */
    allowedCurrencies: z.array(z.string().min(3).max(8)).max(50).default([]),

    /** Whether a balance may go past zero on its normal side. */
    allowNegativeBalance: z.boolean().default(false),
    /** How far, when it may. A decimal string, per currency, keyed by currency code. */
    overdraftLimits: z.record(z.string()).default({}),

    /**
     * Above this, a transaction needs somebody to approve it.
     *
     * Per currency. Null means no threshold — every transaction proceeds without review, which is
     * a legitimate configuration for a low-value platform and a decision worth making explicitly.
     */
    approvalThresholds: z.record(z.string()).default({}),

    /** Above this, a transaction is flagged as high value for reporting and risk. */
    highValueThresholds: z.record(z.string()).default({}),

    /** Whether a transaction whose risk decision is `review` may proceed while it is reviewed. */
    allowRiskReviewToProceed: z.boolean().default(false),

    /** How often settlement runs, in milliseconds. Informational; the scheduler enforces it. */
    settlementWindowMs: z.number().int().min(60_000).nullable().default(null),
    /** The account settlement passes through, per currency. */
    settlementAccountCodes: z.record(z.string()).default({}),

    /** The fee schedule that applies by default, per transaction type. */
    feeScheduleKeys: z.record(z.string()).default({}),

    /**
     * Whether a reversal needs a second person.
     *
     * True by default. A reversal moves money back with one person's decision, and it is the one
     * operation in the phase that can be used to hide another.
     */
    requireApprovalForReversal: z.boolean().default(true),

    enabled: z.boolean().default(true),
  })
  .strict();

export type FinancialPolicy = z.infer<typeof financialPolicySchema>;

export interface PolicyContext {
  organizationId: string | null;
  accountType?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Which policy decided. Always named — "denied" with no reason is unfixable. */
  policyName: string;
  reasons: string[];
  /** Set when the amount is above the approval threshold. */
  requiresApproval: boolean;
  /** Set when the amount is above the high-value threshold. */
  highValue: boolean;
}

export class FinancialPolicyEngine {
  private readonly policies: FinancialPolicy[] = [];

  constructor(
    policies: unknown[] = [],
    private readonly currencies?: CurrencyRegistry,
  ) {
    for (const policy of policies) this.register(policy);

    if (!this.policies.some((policy) => policy.scope.kind === 'platform')) {
      /*
       * There is always a platform policy.
       *
       * Without one, a tenant with no policy of its own falls through to "no policy", and the only
       * readings of that are "allow everything" or "deny everything". The first is unsafe and the
       * second makes the platform unusable, so an explicit default is the only honest option.
       */
      this.policies.push(
        financialPolicySchema.parse({
          name: 'platform-default',
          scope: { kind: 'platform' },
          allowedCurrencies: [],
          allowNegativeBalance: false,
          requireApprovalForReversal: true,
        }),
      );
    }
  }

  register(input: unknown): FinancialPolicy {
    const parsed = financialPolicySchema.safeParse(input);

    if (!parsed.success) {
      const name = (input as { name?: string } | null)?.name ?? '(unnamed)';

      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `${name}.${issue.path.join('.')}`,
          message: issue.message,
        })),
        `The financial policy "${name}" is not valid.`,
      );
    }

    this.policies.push(parsed.data);
    return parsed.data;
  }

  /**
   * The policy that applies.
   *
   * Most specific wins, whole. Never merged — see the header.
   */
  resolve(context: PolicyContext): FinancialPolicy {
    const enabled = this.policies.filter((policy) => policy.enabled);

    const byAccountType = context.accountType
      ? enabled.find(
          (policy) =>
            policy.scope.kind === 'account_type' &&
            policy.scope.accountType === context.accountType,
        )
      : undefined;

    if (byAccountType) return byAccountType;

    const byOrganization = enabled.find(
      (policy) =>
        policy.scope.kind === 'organization' &&
        policy.scope.organizationId === context.organizationId,
    );

    if (byOrganization) return byOrganization;

    return (
      enabled.find((policy) => policy.scope.kind === 'platform') ??
      financialPolicySchema.parse({ name: 'platform-default', scope: { kind: 'platform' } })
    );
  }

  /**
   * Whether a movement is permitted, and what it needs.
   *
   * Returns every reason rather than the first, because a caller fixing a configuration wants the
   * whole list — and an operator who fixes one thing only to hit the next is an operator who
   * stops trusting the message.
   */
  check(input: {
    context: PolicyContext;
    amount?: Money;
    resultingBalance?: Money;
    operation?: 'transfer' | 'reversal' | 'settlement' | 'refund';
  }): PolicyDecision {
    const policy = this.resolve(input.context);
    const reasons: string[] = [];

    let requiresApproval = false;
    let highValue = false;

    if (input.amount) {
      const currency = input.amount.currency;

      if (policy.allowedCurrencies.length > 0 && !policy.allowedCurrencies.includes(currency)) {
        reasons.push(
          `The "${policy.name}" policy does not permit ${currency}. Permitted: ` +
            `${policy.allowedCurrencies.join(', ')}.`,
        );
      } else if (policy.allowedCurrencies.length === 0) {
        /*
         * An empty list means none.
         *
         * The opposite reading — "empty means all" — is the one that makes an unconfigured
         * platform accept every currency, and the first symptom is a balance in a currency nobody
         * can settle.
         */
        reasons.push(
          `The "${policy.name}" policy lists no permitted currencies, so nothing may be ` +
            'transacted. An empty list means none rather than all: an unconfigured platform that ' +
            'accepted every currency would produce balances nobody can settle.',
        );
      }

      const approval = policy.approvalThresholds[currency];

      if (approval) {
        const threshold = money(approval, currency, this.currencies);
        requiresApproval = compareMoney(input.amount, threshold) > 0;
      }

      const high = policy.highValueThresholds[currency];

      if (high) {
        highValue = compareMoney(input.amount, money(high, currency, this.currencies)) > 0;
      }
    }

    if (input.resultingBalance && input.resultingBalance.amount.units < 0n) {
      if (!policy.allowNegativeBalance) {
        reasons.push(
          `The "${policy.name}" policy does not permit a negative balance, and this would leave ` +
            `${formatMoney(input.resultingBalance)}.`,
        );
      } else {
        const limit = policy.overdraftLimits[input.resultingBalance.currency];

        if (limit) {
          const bound = money(limit, input.resultingBalance.currency, this.currencies);

          if (-input.resultingBalance.amount.units > bound.amount.units) {
            reasons.push(
              `This would leave ${formatMoney(input.resultingBalance)}, past the ` +
                `${formatMoney(bound)} overdraft limit in the "${policy.name}" policy.`,
            );
          }
        }
      }
    }

    if (input.operation === 'reversal' && policy.requireApprovalForReversal) {
      // Not a refusal: a statement that this needs a second person. A reversal is the one
      // operation in the phase that can be used to hide another.
      requiresApproval = true;
    }

    return {
      allowed: reasons.length === 0,
      policyName: policy.name,
      reasons,
      requiresApproval,
      highValue,
    };
  }

  /** Refuses when the policy does, with every reason. */
  assert(input: Parameters<FinancialPolicyEngine['check']>[0]): PolicyDecision {
    const decision = this.check(input);

    if (!decision.allowed) {
      throw ApiError.forbidden(decision.reasons.join(' '), {
        reason: 'financial_policy_denied',
        policy: decision.policyName,
      });
    }

    return decision;
  }

  /** The default fee schedule for a transaction type, when the policy names one. */
  feeScheduleFor(context: PolicyContext, transactionType: string): string | null {
    return this.resolve(context).feeScheduleKeys[transactionType] ?? null;
  }

  /** The settlement account for a currency, when the policy names one. */
  settlementAccountFor(context: PolicyContext, currency: string): string | null {
    return this.resolve(context).settlementAccountCodes[currency] ?? null;
  }

  list(): FinancialPolicy[] {
    return [...this.policies];
  }
}
