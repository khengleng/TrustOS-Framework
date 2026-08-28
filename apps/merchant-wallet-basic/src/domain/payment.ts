import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { addMoney, money, moneyToJson, subtractMoney, type Money } from '@trustos/financial-core';
import { calculateFee, type FeeCalculation, type FeeSchedule } from '@trustos/fees';
import type { LimitEngine } from '@trustos/limits';
import { credit, debit, type Ledger } from '@trustos/ledger';
import type { WalletBalance, WalletService } from '@trustos/wallet';
import type { AuditService } from '@trustos/audit';
import type { Merchant } from './merchant';

/**
 * Accepting a payment.
 *
 * The flow the specification asks for, in order:
 *
 *   validate merchant → check product → check wallet → check limit → risk → fee
 *   → record transaction → post ledger → return
 *
 * Four properties of that ordering are worth stating, because each is a decision rather than a
 * consequence of writing it down:
 *
 * **The limit is *consumed*, not checked.** `LimitEngine.check` tells a caller what they could do;
 * two concurrent callers both pass it. `consume` reserves. A payment path that checked would let a
 * merchant exceed a daily limit by exactly the number of requests in flight — which is small, and
 * is the number that matters when the limit is a fraud control.
 *
 * **The fee is computed before the ledger and posted with it.** One journal, three entries: the
 * gross to the wallet, the fee to revenue, the net as the balancing credit. Posting the payment
 * and the fee as two journals means a window in which the merchant's balance is wrong, and the
 * window is where a reconciliation exception is born.
 *
 * **The ledger is the last thing to happen and the transaction is not confirmed before it.** If
 * the posting fails, the payment failed. A transaction marked settled whose journal did not post
 * is money the platform believes it holds and cannot account for.
 *
 * **Idempotency is on the payment reference, not on a generated key.** The merchant's own order
 * reference is what they will retry with, and a key the platform generates is a key the merchant
 * does not have when their connection drops mid-request.
 */

export const paymentRequestSchema = z
  .object({
    merchantId: z.string().min(3).max(64),
    /** A decimal string. Money is never a float — see @trustos/financial-core. */
    amount: z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'A decimal amount, as a string.'),
    currency: z.string().length(3),
    /** The merchant's own reference. Doubles as the idempotency key. */
    reference: z.string().min(1).max(120),
    branchId: z.string().min(3).max(64).nullable().default(null),
    /** Opaque to the platform. Whatever the merchant's own system needs back. */
    metadata: z.record(z.string().max(200)).default({}),
  })
  .strict();

export type PaymentRequest = z.infer<typeof paymentRequestSchema>;

export const PAYMENT_REFUSAL_CODES = [
  'merchant_not_found',
  'merchant_not_approved',
  'product_not_bound',
  'wallet_not_found',
  'wallet_frozen',
  'currency_mismatch',
  'limit_exceeded',
  'risk_refused',
  'duplicate_reference',
  'provider_unavailable',
  'ledger_refused',
] as const;
export type PaymentRefusalCode = (typeof PAYMENT_REFUSAL_CODES)[number];

export interface PaymentResult {
  readonly paymentId: string;
  readonly merchantId: string;
  readonly reference: string;
  readonly status: 'accepted' | 'refused';
  readonly gross: ReturnType<typeof moneyToJson> | null;
  readonly fee: ReturnType<typeof moneyToJson> | null;
  readonly net: ReturnType<typeof moneyToJson> | null;
  readonly journalId: string | null;
  readonly refusalCode: PaymentRefusalCode | null;
  readonly reason: string | null;
  /** True when this response replays an earlier one rather than doing the work again. */
  readonly replayed: boolean;
  readonly acceptedAt: string;
  readonly correlationId: string;
}

/**
 * A mock risk rule.
 *
 * Deliberately trivial and deliberately *pluggable*. The pilot needs a refusal path to test; it
 * does not need a risk engine, and a plausible-looking one here would be the first thing somebody
 * copied into production.
 *
 * The default refuses a payment whose reference declares itself a test of the refusal path, which
 * makes the scenario reproducible without encoding any judgement about real transactions.
 */
export type RiskRule = (input: { merchant: Merchant; amount: Money; request: PaymentRequest }) => {
  refused: boolean;
  reason: string | null;
};

export const defaultRiskRule: RiskRule = ({ request }) =>
  request.reference.startsWith('RISK-REFUSE')
    ? { refused: true, reason: 'The mock risk rule refuses references beginning RISK-REFUSE.' }
    : { refused: false, reason: null };

/**
 * A mock payment provider.
 *
 * The pilot integrates no payment rail. This port exists so the sandbox can exercise a provider
 * timeout, which is a failure mode the flow has to handle and which cannot be tested without
 * something to fail.
 */
export interface MockPaymentProvider {
  authorize(input: {
    merchantId: string;
    amount: Money;
    reference: string;
  }): Promise<{ authorized: boolean; providerRef: string; reason: string | null }>;
}

export const alwaysAuthorizes: MockPaymentProvider = {
  async authorize({ reference }) {
    if (reference.startsWith('PROVIDER-TIMEOUT')) {
      throw ApiError.internal('The mock provider did not respond within its timeout.');
    }
    return { authorized: true, providerRef: `mock_${reference}`, reason: null };
  },
};

export interface PaymentEngineOptions {
  wallets: WalletService;
  ledger: Ledger;
  limits: LimitEngine;
  feeSchedule: FeeSchedule;
  provider?: MockPaymentProvider;
  riskRule?: RiskRule;
  audit?: Pick<AuditService, 'record'>;
  /** Resolves the merchant. The engine holds no store of its own. */
  findMerchant: (merchantId: string, organizationId: string) => Promise<Merchant | null>;
  /** Where the fee is recognized. A revenue account in the platform's own chart. */
  feeRevenueAccountId: string;
  /**
   * The counter-account the gross arrives into.
   *
   * Explicit and required, following `WalletService.credit`'s rule: the other side of a deposit is
   * a real decision — a bank account, a provider float, a suspense account — and a default would
   * be one of them chosen for everybody.
   */
  clearingAccountId: string;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

/**
 * A record of an accepted payment.
 *
 * Held so a repeated reference replays rather than re-executes. In a deployment this is a table;
 * the pilot keeps it in memory and says so.
 */
export interface AcceptedPayment {
  readonly result: PaymentResult;
  readonly organizationId: string;
}

export class PaymentEngine {
  private readonly accepted = new Map<string, AcceptedPayment>();
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private counter = 0;

  constructor(private readonly options: PaymentEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${(this.counter += 1).toString(36)}`);
  }

  private static key(organizationId: string, merchantId: string, reference: string): string {
    return `${organizationId}::${merchantId}::${reference}`;
  }

  private refuse(input: {
    request: PaymentRequest;
    code: PaymentRefusalCode;
    reason: string;
    correlationId: string;
  }): PaymentResult {
    return {
      paymentId: this.newId('pay'),
      merchantId: input.request.merchantId,
      reference: input.request.reference,
      status: 'refused',
      gross: null,
      fee: null,
      net: null,
      journalId: null,
      refusalCode: input.code,
      reason: input.reason,
      replayed: false,
      acceptedAt: this.now().toISOString(),
      correlationId: input.correlationId,
    };
  }

  async accept(input: {
    request: PaymentRequest;
    organizationId: string;
    actorId: string;
    correlationId: string;
  }): Promise<PaymentResult> {
    const { request, organizationId } = input;
    const key = PaymentEngine.key(organizationId, request.merchantId, request.reference);

    /*
     * Idempotency first, before anything is checked or counted.
     *
     * A retry of an accepted payment must not consume the limit a second time, and it must not
     * post a second journal. Both would be invisible to the merchant, who sees one response either
     * way, and both are discovered by a reconciliation weeks later.
     */
    const replay = this.accepted.get(key);
    if (replay && replay.organizationId === organizationId) {
      return { ...replay.result, replayed: true };
    }

    // 1. Validate the merchant.
    const merchant = await this.options.findMerchant(request.merchantId, organizationId);

    if (!merchant) {
      return this.refuse({
        request,
        code: 'merchant_not_found',
        reason: 'No such merchant in this organization.',
        correlationId: input.correlationId,
      });
    }

    if (merchant.status !== 'approved') {
      return this.refuse({
        request,
        code: 'merchant_not_approved',
        reason: `This merchant is ${merchant.status}.`,
        correlationId: input.correlationId,
      });
    }

    // 2. Check the product binding.
    if (!merchant.productId || !merchant.productVersion) {
      return this.refuse({
        request,
        code: 'product_not_bound',
        reason: 'This merchant is not bound to a product version.',
        correlationId: input.correlationId,
      });
    }

    if (merchant.currency !== request.currency) {
      return this.refuse({
        request,
        code: 'currency_mismatch',
        reason: `This merchant transacts in ${merchant.currency}.`,
        correlationId: input.correlationId,
      });
    }

    const gross = money(request.amount, request.currency);

    // 3. Check the wallet.
    const walletId = await this.walletFor(merchant, organizationId);
    const wallet = await this.options.wallets.get(walletId, organizationId);
    const balance: WalletBalance = await this.options.wallets.balance(walletId, organizationId);
    void balance;

    if (wallet.status === 'frozen') {
      return this.refuse({
        request,
        code: 'wallet_frozen',
        reason: 'This wallet is frozen and cannot receive payments.',
        correlationId: input.correlationId,
      });
    }

    // 4. Consume the limit. Not check — see the header.
    try {
      await this.options.limits.consume({
        organizationId,
        scope: 'wallet',
        subjectId: walletId,
        amount: gross,
        idempotencyKey: key,
      });
    } catch (error) {
      return this.refuse({
        request,
        code: 'limit_exceeded',
        reason: error instanceof Error ? error.message : 'A limit refused this payment.',
        correlationId: input.correlationId,
      });
    }

    // 5. The mock risk rule.
    const risk = (this.options.riskRule ?? defaultRiskRule)({ merchant, amount: gross, request });

    if (risk.refused) {
      return this.refuse({
        request,
        code: 'risk_refused',
        reason: risk.reason ?? 'Refused by the risk rule.',
        correlationId: input.correlationId,
      });
    }

    // 6. The mock provider.
    try {
      const authorization = await (this.options.provider ?? alwaysAuthorizes).authorize({
        merchantId: merchant.merchantId,
        amount: gross,
        reference: request.reference,
      });

      if (!authorization.authorized) {
        return this.refuse({
          request,
          code: 'provider_unavailable',
          reason: authorization.reason ?? 'The provider did not authorize this payment.',
          correlationId: input.correlationId,
        });
      }
    } catch (error) {
      return this.refuse({
        request,
        code: 'provider_unavailable',
        reason: error instanceof Error ? error.message : 'The provider did not respond.',
        correlationId: input.correlationId,
      });
    }

    // 7. The fee, from the product's schedule rather than from this file.
    const calculation: FeeCalculation = calculateFee({
      schedule: this.options.feeSchedule,
      amount: gross,
      at: this.now(),
    });

    const fee = calculation.total;
    const net = subtractMoney(gross, fee);

    /*
     * 8. One journal. Three entries, balanced.
     *
     * Posted through the ledger directly rather than through `WalletService.credit`, which posts
     * a two-entry journal of its own. Two journals would mean the fee and the credit are separate
     * postings with a window between them, and the wallet balance is derived from the ledger —
     * so crediting *as well* would count the money twice.
     */
    const accountId = wallet.accountId;

    let journalId: string;

    try {
      const journal = await this.options.ledger.post({
        organizationId,
        description: `Payment ${request.reference} for ${merchant.tradingName}`,
        reference: request.reference,
        idempotencyKey: key,
        actorId: input.actorId,
        entries: [
          debit(this.options.clearingAccountId, gross, {
            description: 'Gross payment received into clearing.',
          }),
          credit(accountId, net, { description: 'Net proceeds credited to the merchant wallet.' }),
          credit(this.options.feeRevenueAccountId, fee, { description: 'Merchant service fee.' }),
        ],
        metadata: {
          merchantId: merchant.merchantId,
          productId: merchant.productId,
          productVersion: merchant.productVersion,
          correlationId: input.correlationId,
          ...(request.branchId ? { branchId: request.branchId } : {}),
        },
      });

      journalId = journal.id;
    } catch (error) {
      /*
       * The posting failed, so the payment failed.
       *
       * The limit has already been consumed under the same idempotency key. That is the correct
       * direction to be wrong in: a merchant whose limit was consumed by a failed payment can
       * retry with the same reference and the limit will not double-count, whereas a payment
       * confirmed without a journal is money the platform believes it holds and cannot account for.
       */
      return this.refuse({
        request,
        code: 'ledger_refused',
        reason: error instanceof Error ? error.message : 'The ledger refused this posting.',
        correlationId: input.correlationId,
      });
    }

    const result: PaymentResult = {
      paymentId: this.newId('pay'),
      merchantId: merchant.merchantId,
      reference: request.reference,
      status: 'accepted',
      gross: moneyToJson(gross),
      fee: moneyToJson(fee),
      net: moneyToJson(net),
      journalId,
      refusalCode: null,
      reason: null,
      replayed: false,
      acceptedAt: this.now().toISOString(),
      correlationId: input.correlationId,
    };

    this.accepted.set(key, { result, organizationId });

    await this.options.audit?.record({
      action: 'mwb.payment.accepted',
      entityType: 'payment',
      entityId: result.paymentId,
      actorId: input.actorId,
      organizationId,
      after: { gross: result.gross, fee: result.fee, net: result.net, journalId },
      metadata: {
        merchantId: merchant.merchantId,
        reference: request.reference,
        correlationId: input.correlationId,
      },
    });

    return result;
  }

  /** The merchant's wallet id. Opened on approval, so this resolves for an approved merchant. */
  private async walletFor(merchant: Merchant, organizationId: string): Promise<string> {
    const wallet = await this.options.wallets
      .open({
        organizationId,
        ownerId: merchant.merchantId,
        ownerType: 'merchant',
        currency: merchant.currency,
        name: merchant.tradingName,
      })
      .catch(async (error: unknown) => {
        /*
         * `open` refuses a second wallet for the same owner and currency, which is what we want —
         * the refusal carries the existing wallet's id, so this resolves rather than creating.
         */
        const existing = (error as { context?: { walletId?: string } }).context?.walletId;
        if (existing) return { id: existing };
        throw error;
      });

    return wallet.id;
  }

  /** What has been accepted, for the evidence pack. */
  acceptedPayments(): PaymentResult[] {
    return [...this.accepted.values()].map((entry) => entry.result);
  }

  /** Gross, fee and net across everything accepted — reconciled against the ledger in the tests. */
  totals(currency: string): { gross: Money; fee: Money; net: Money; count: number } {
    let gross = money('0', currency);
    let fee = money('0', currency);
    let net = money('0', currency);
    let count = 0;

    for (const entry of this.accepted.values()) {
      if (entry.result.status !== 'accepted' || entry.result.gross === null) continue;
      gross = addMoney(gross, money(entry.result.gross.amount, currency));
      fee = addMoney(fee, money((entry.result.fee as { amount: string }).amount, currency));
      net = addMoney(net, money((entry.result.net as { amount: string }).amount, currency));
      count += 1;
    }

    return { gross, fee, net, count };
  }
}
