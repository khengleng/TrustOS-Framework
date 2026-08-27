import type { ProductDefinition } from '@trustos/financial-product-core';
import { ProductComposer, type ComposerOptions } from './composer';

/**
 * The product template library.
 *
 * Five templates from section 10 of the specification, plus the provider-neutral worked example
 * from section 30. A template is a **starting point that already validates** — every one of these
 * passes `validateProduct` with no errors, which is the property that makes them worth shipping.
 * A template a product owner has to fix before it validates is a template that teaches them the
 * validator is noise.
 *
 * Two things they deliberately do not contain:
 *
 * **No provider.** Not one, in any of them. Every provider-dependent block names an interface and
 * leaves the connector to the deployment. A template that bound a real rail would be a template
 * only the deployment with that rail could use.
 *
 * **No jurisdiction.** No country list, no currency beyond a generic one, no KYC level, no
 * regulatory threshold. Those are a deployment's own, and a template that shipped Cambodia's
 * would be copied into Vietnam unchanged.
 *
 * The shape they all share is worth reading once, because it is what makes them validate. Every
 * product opens with an authentication block and branches on `transactionType` — not because
 * every product needs a dispatcher, but because a product is **one graph**, and the operations a
 * wallet offers (onboard, cash in, pay, cash out) are branches of it rather than four separate
 * documents. The alternative — four products called "Consumer Wallet" — is the duplication this
 * layer exists to remove.
 *
 * A limit block therefore always sits after the authentication and before every branch that moves
 * money, which is exactly what the ordering analysis in `validate.ts` insists on. That is not a
 * coincidence: the rule was written first and the templates were made to satisfy it.
 */

const OWNERSHIP = {
  businessOwner: 'role:product-owner',
  technicalOwner: 'role:platform-engineering',
  riskOwner: 'role:risk',
  complianceOwner: 'role:compliance',
} as const;

const COMPLIANCE = {
  dataClassification: 'confidential' as const,
  retentionDays: 2555,
  screening: ['aml' as const, 'sanctions' as const],
};

/**
 * A generic currency.
 *
 * Deliberately `XTS` — the ISO 4217 code reserved for testing, which no country uses and no
 * provider settles. A template shipped with `USD` gets deployed with `USD` by somebody who did
 * not notice they had to change it, and the mistake is invisible until a balance is reported in
 * the wrong currency.
 */
const TEMPLATE_CURRENCY = 'XTS';

function baseOptions(
  productId: string,
  productName: string,
  productType: ProductDefinition['productType'],
  description: string,
): ComposerOptions {
  return {
    productId,
    productName,
    productType,
    description,
    version: '1.0.0',
    ownership: OWNERSHIP,
    supportedCountries: [],
    supportedCurrencies: [TEMPLATE_CURRENCY],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    compliancePolicy: COMPLIANCE,
    auditClassification: 'sensitive',
    apiSlug: productId,
  };
}

/** `transactionType == X`. The dispatcher condition every template branches on. */
function isType(value: string) {
  return { field: 'transactionType', operator: 'eq' as const, value };
}

function isOneOf(values: string[]) {
  return { field: 'transactionType', operator: 'in' as const, value: values };
}

// --- consumer wallet --------------------------------------------------------

/**
 * Consumer Wallet.
 *
 * Onboarding, KYC, wallet creation, cash-in, person-to-person, merchant payment, cash-out, limits,
 * fees and settlement — section 10's list, as one graph with two branches off the dispatcher.
 */
export function consumerWalletTemplate(): ProductDefinition {
  const composer = new ProductComposer(
    baseOptions(
      'consumer-wallet',
      'Consumer Wallet',
      'wallet',
      'A consumer wallet: onboarding, cash-in, person-to-person transfer, merchant payment and cash-out, on a ledger-backed balance.',
    ),
  );

  composer
    .addBlock({ key: 'authenticate', blockId: 'identity.authenticate', blockVersion: '1.0.0' })

    // --- onboarding ---------------------------------------------------------
    .addBlock({
      key: 'check-eligibility',
      blockId: 'identity.customer_eligibility',
      blockVersion: '1.0.0',
    })
    .addBlock({ key: 'check-kyc', blockId: 'identity.kyc_check', blockVersion: '1.0.0' })
    .addBlock({ key: 'create-wallet', blockId: 'wallet.create', blockVersion: '1.0.0' })
    .addBlock({ key: 'activate-wallet', blockId: 'wallet.activate', blockVersion: '1.0.0' })
    .addBlock({ key: 'notify-onboarded', blockId: 'notification.send', blockVersion: '1.0.0' })

    // --- transacting --------------------------------------------------------
    .addBlock({ key: 'score-risk', blockId: 'risk.score', blockVersion: '1.0.0' })
    .addBlock({
      key: 'consume-daily-limit',
      blockId: 'limit.daily',
      blockVersion: '1.0.0',
      configuration: { limitCode: 'DAILY_SPEND' },
    })
    .addBlock({
      key: 'cash-in',
      blockId: 'wallet.credit',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'send-p2p',
      blockId: 'transfer.p2p',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'pay-merchant',
      blockId: 'transfer.merchant_payment',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'cash-out',
      blockId: 'wallet.debit',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'apply-fee',
      blockId: 'fee.percentage',
      blockVersion: '1.0.0',
      configuration: { feeCode: 'TRANSACTION' },
    })
    .addBlock({
      key: 'post-ledger',
      blockId: 'ledger.create_journal',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'settle',
      blockId: 'settlement.create',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['adjust-settlement'],
    })
    .addBlock({ key: 'reconcile', blockId: 'reconciliation.match', blockVersion: '1.0.0' })

    // --- compensation -------------------------------------------------------
    .addBlock({ key: 'reverse-posting', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
    .addBlock({
      key: 'adjust-settlement',
      blockId: 'settlement.adjustment',
      blockVersion: '1.0.0',
    });

  composer
    .connect('start', 'authenticate', 'always')
    .branch('authenticate', 'check-eligibility', isType('ONBOARD'))
    .branch('authenticate', 'score-risk', isOneOf(['CREDIT', 'DEBIT', 'TRANSFER']))

    .connect('check-eligibility', 'check-kyc')
    .connect('check-kyc', 'create-wallet')
    .connect('create-wallet', 'activate-wallet')
    .connect('activate-wallet', 'notify-onboarded')
    .connect('notify-onboarded', 'completed')

    .connect('score-risk', 'consume-daily-limit')
    .branch('consume-daily-limit', 'cash-in', isType('CREDIT'))
    .branch('consume-daily-limit', 'send-p2p', isType('TRANSFER'))
    .branch('consume-daily-limit', 'pay-merchant', isType('MERCHANT'))
    .branch('consume-daily-limit', 'cash-out', isType('DEBIT'))

    .connect('cash-in', 'apply-fee')
    .connect('send-p2p', 'apply-fee')
    .connect('pay-merchant', 'apply-fee')
    .connect('cash-out', 'apply-fee')
    .connect('apply-fee', 'post-ledger')
    .connect('post-ledger', 'settle')
    .connect('settle', 'reconcile')
    .connect('reconcile', 'completed')

    .connect('reverse-posting', 'failed', 'always')
    .connect('adjust-settlement', 'failed', 'always');

  composer
    .addFee({
      code: 'TRANSACTION',
      feeType: 'PERCENTAGE',
      basis: 'percentage',
      rate: { hundredthsOfBasisPoint: '10000' },
      bearer: 'payer',
      rounding: 'half_even',
      description: 'A placeholder 1% transaction fee. Configure before publication.',
    })
    .addLimit({
      code: 'DAILY_SPEND',
      limitType: 'DAILY',
      scope: 'customer',
      amount: { minorUnits: '100000', currency: TEMPLATE_CURRENCY },
      description: 'A placeholder daily spend ceiling. Configure before publication.',
    })
    .withRiskPolicy({
      prohibitedRiskLevels: ['PROHIBITED'],
      requiredChecks: ['risk'],
      manualReviewScore: 80,
    })
    .withSettlement({ schedule: 'daily', calendar: 'BUSINESS_DAYS', cutoff: '17:00', holdDays: 1 })
    .withReconciliation({
      frequency: 'daily',
      toleranceMinorUnits: '0',
      exceptionSlaHours: 24,
      blocksSettlement: true,
    });

  return composer.build();
}

// --- merchant wallet --------------------------------------------------------

/**
 * Merchant Wallet.
 *
 * Merchant onboarding, business verification, wallet, payment acceptance, refund, settlement,
 * reconciliation and a reporting hook. The refund branch is what distinguishes it from the
 * consumer wallet: a merchant product that cannot refund is a merchant product whose disputes are
 * handled by hand.
 */
export function merchantWalletTemplate(): ProductDefinition {
  const composer = new ProductComposer(
    baseOptions(
      'merchant-wallet',
      'Merchant Wallet',
      'merchant',
      'A merchant wallet: business verification, payment acceptance, refund, settlement and reconciliation.',
    ),
  );

  composer
    .addBlock({ key: 'authenticate', blockId: 'identity.authenticate', blockVersion: '1.0.0' })

    .addBlock({
      key: 'verify-business',
      blockId: 'identity.customer_eligibility',
      blockVersion: '1.0.0',
    })
    .addBlock({ key: 'screen-merchant', blockId: 'risk.sanctions_check', blockVersion: '1.0.0' })
    .addBlock({ key: 'create-wallet', blockId: 'wallet.create', blockVersion: '1.0.0' })
    .addBlock({ key: 'activate-wallet', blockId: 'wallet.activate', blockVersion: '1.0.0' })
    .addBlock({ key: 'notify-onboarded', blockId: 'notification.send', blockVersion: '1.0.0' })

    .addBlock({ key: 'screen-transaction', blockId: 'risk.fraud_check', blockVersion: '1.0.0' })
    .addBlock({
      key: 'consume-acceptance-limit',
      blockId: 'limit.daily',
      blockVersion: '1.0.0',
      configuration: { limitCode: 'DAILY_ACCEPTANCE' },
    })
    .addBlock({
      key: 'accept-payment',
      blockId: 'payment.execute',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['refund-payment'],
    })
    .addBlock({
      key: 'refund-payment',
      blockId: 'payment.refund',
      blockVersion: '1.0.0',
    })
    .addBlock({
      key: 'apply-acceptance-fee',
      blockId: 'fee.percentage',
      blockVersion: '1.0.0',
      configuration: { feeCode: 'ACCEPTANCE' },
    })
    .addBlock({
      key: 'post-ledger',
      blockId: 'ledger.create_journal',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'settle',
      blockId: 'settlement.create',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['adjust-settlement'],
    })
    .addBlock({ key: 'reconcile', blockId: 'reconciliation.match', blockVersion: '1.0.0' })
    .addBlock({ key: 'report', blockId: 'reconciliation.report', blockVersion: '1.0.0' })

    .addBlock({ key: 'reverse-posting', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
    .addBlock({
      key: 'adjust-settlement',
      blockId: 'settlement.adjustment',
      blockVersion: '1.0.0',
    });

  composer
    .connect('start', 'authenticate', 'always')
    .branch('authenticate', 'verify-business', isType('ONBOARD'))
    .branch('authenticate', 'screen-transaction', isOneOf(['CREDIT', 'REFUND']))

    .connect('verify-business', 'screen-merchant')
    .connect('screen-merchant', 'create-wallet')
    .connect('create-wallet', 'activate-wallet')
    .connect('activate-wallet', 'notify-onboarded')
    .connect('notify-onboarded', 'completed')

    .connect('screen-transaction', 'consume-acceptance-limit')
    .branch('consume-acceptance-limit', 'accept-payment', isType('CREDIT'))
    .branch('consume-acceptance-limit', 'refund-payment', isType('REFUND'))
    .connect('accept-payment', 'apply-acceptance-fee')
    .connect('refund-payment', 'post-ledger')
    .connect('apply-acceptance-fee', 'post-ledger')
    .connect('post-ledger', 'settle')
    .connect('settle', 'reconcile')
    .connect('reconcile', 'report')
    .connect('report', 'completed')

    .connect('reverse-posting', 'failed', 'always')
    .connect('adjust-settlement', 'failed', 'always');

  composer
    .addFee({
      code: 'ACCEPTANCE',
      feeType: 'PERCENTAGE',
      basis: 'percentage',
      rate: { hundredthsOfBasisPoint: '5000' },
      bearer: 'payee',
      rounding: 'half_even',
      description: 'A placeholder 0.5% acceptance fee. Configure before publication.',
    })
    .addLimit({
      code: 'DAILY_ACCEPTANCE',
      limitType: 'DAILY',
      scope: 'merchant',
      amount: { minorUnits: '500000', currency: TEMPLATE_CURRENCY },
      description: 'A placeholder daily acceptance ceiling. Configure before publication.',
    })
    .withRiskPolicy({
      enhancedReviewAbove: { minorUnits: '200000', currency: TEMPLATE_CURRENCY },
      prohibitedRiskLevels: ['PROHIBITED'],
      requiredChecks: ['risk'],
      manualReviewScore: 80,
    })
    .withSettlement({ schedule: 'daily', calendar: 'BUSINESS_DAYS', cutoff: '18:00', holdDays: 1 })
    .withReconciliation({
      frequency: 'daily',
      toleranceMinorUnits: '0',
      exceptionSlaHours: 24,
      blocksSettlement: true,
    });

  return composer.build();
}

// --- microloan --------------------------------------------------------------

/**
 * Microloan.
 *
 * Application, KYC, eligibility, credit assessment, approval, disbursement, repayment, a
 * collection trigger and closure.
 *
 * The credit assessment is a **hook**, not a model. The framework ships no scoring — one shipped
 * here would be a wrong one that every deployment believed, and credit models are the part of
 * lending that is most specific to a market.
 */
export function microloanTemplate(): ProductDefinition {
  const composer = new ProductComposer(
    baseOptions(
      'microloan',
      'Microloan',
      'lending',
      'A microloan: eligibility, an external credit assessment, approval, disbursement, repayment and a collection trigger.',
    ),
  );

  composer
    .addBlock({ key: 'authenticate', blockId: 'identity.authenticate', blockVersion: '1.0.0' })
    .addBlock({ key: 'check-kyc', blockId: 'identity.kyc_check', blockVersion: '1.0.0' })

    .addBlock({
      key: 'check-eligibility',
      blockId: 'lending.check_eligibility',
      blockVersion: '1.0.0',
    })
    .addBlock({ key: 'assess-credit', blockId: 'lending.credit_assessment', blockVersion: '1.0.0' })
    .addBlock({ key: 'score-risk', blockId: 'risk.score', blockVersion: '1.0.0' })
    .addBlock({
      key: 'approve-application',
      blockId: 'risk.manual_review',
      blockVersion: '1.0.0',
      requiresApproval: true,
    })
    .addBlock({ key: 'make-offer', blockId: 'lending.loan_offer', blockVersion: '1.0.0' })
    .addBlock({
      key: 'build-schedule',
      blockId: 'lending.repayment_schedule',
      blockVersion: '1.0.0',
    })
    .addBlock({
      key: 'consume-exposure-limit',
      blockId: 'limit.product',
      blockVersion: '1.0.0',
      configuration: { limitCode: 'PORTFOLIO_EXPOSURE' },
    })
    .addBlock({
      key: 'disburse',
      blockId: 'lending.disburse',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'consume-repayment-limit',
      blockId: 'limit.transaction',
      blockVersion: '1.0.0',
      configuration: { limitCode: 'REPAYMENT' },
    })
    .addBlock({
      key: 'repay',
      blockId: 'lending.repay',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'apply-penalty',
      blockId: 'lending.apply_penalty',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'trigger-collection',
      blockId: 'lending.trigger_collection',
      blockVersion: '1.0.0',
    })
    .addBlock({
      key: 'post-ledger',
      blockId: 'ledger.create_journal',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({ key: 'notify', blockId: 'notification.send', blockVersion: '1.0.0' })
    .addBlock({ key: 'reverse-posting', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' });

  composer
    .connect('start', 'authenticate', 'always')
    .connect('authenticate', 'check-kyc')
    .branch('check-kyc', 'check-eligibility', isType('APPLICATION'))
    .branch('check-kyc', 'consume-repayment-limit', isType('REPAYMENT'))

    .connect('check-eligibility', 'assess-credit')
    .connect('assess-credit', 'score-risk')
    .connect('score-risk', 'consume-exposure-limit')
    .connect('consume-exposure-limit', 'approve-application')
    .connect('approve-application', 'make-offer')
    .connect('make-offer', 'build-schedule')
    .connect('build-schedule', 'disburse')
    .connect('disburse', 'post-ledger')

    .connect('consume-repayment-limit', 'repay')
    .connect('repay', 'apply-penalty')
    .connect('apply-penalty', 'trigger-collection')
    .connect('trigger-collection', 'notify')
    .connect('post-ledger', 'notify')
    .connect('notify', 'completed')

    .connect('reverse-posting', 'failed', 'always');

  composer
    .addLimit({
      code: 'PORTFOLIO_EXPOSURE',
      limitType: 'PER_TRANSACTION',
      scope: 'product',
      amount: { minorUnits: '10000000', currency: TEMPLATE_CURRENCY },
      description: 'A placeholder ceiling on total lending exposure. Configure before publication.',
    })
    .addLimit({
      code: 'REPAYMENT',
      limitType: 'PER_TRANSACTION',
      scope: 'customer',
      amount: { minorUnits: '500000', currency: TEMPLATE_CURRENCY },
      description: 'A placeholder ceiling on a single repayment.',
    })
    .withRiskPolicy({
      prohibitedRiskLevels: ['PROHIBITED', 'HIGH'],
      requiredChecks: ['risk', 'lending'],
      manualReviewScore: 60,
    });

  return composer.build();
}

// --- buy now, pay later -----------------------------------------------------

/**
 * BNPL.
 *
 * Eligibility, purchase, risk check, credit limit, instalment plan, merchant settlement,
 * repayment and collection. The distinguishing shape is that the merchant settles immediately
 * while the customer repays over time — two money movements on different clocks, which is why the
 * settlement branch and the repayment branch are separate paths off the dispatcher.
 */
export function bnplTemplate(): ProductDefinition {
  const composer = new ProductComposer(
    baseOptions(
      'bnpl',
      'Buy Now, Pay Later',
      'lending',
      'Instalment credit at the point of sale: eligibility, a credit limit, an instalment plan, immediate merchant settlement and scheduled repayment.',
    ),
  );

  composer
    .addBlock({ key: 'authenticate', blockId: 'identity.authenticate', blockVersion: '1.0.0' })
    .addBlock({
      key: 'check-eligibility',
      blockId: 'lending.check_eligibility',
      blockVersion: '1.0.0',
    })
    .addBlock({ key: 'screen-fraud', blockId: 'risk.fraud_check', blockVersion: '1.0.0' })
    .addBlock({
      key: 'consume-credit-limit',
      blockId: 'limit.product',
      blockVersion: '1.0.0',
      configuration: { limitCode: 'CREDIT_LINE' },
    })
    .addBlock({ key: 'build-plan', blockId: 'lending.repayment_schedule', blockVersion: '1.0.0' })
    .addBlock({
      key: 'disburse-to-merchant',
      blockId: 'lending.disburse',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'post-ledger',
      blockId: 'ledger.create_journal',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'settle-merchant',
      blockId: 'settlement.create',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['adjust-settlement'],
    })

    .addBlock({
      key: 'consume-instalment-limit',
      blockId: 'limit.transaction',
      blockVersion: '1.0.0',
      configuration: { limitCode: 'INSTALMENT' },
    })
    .addBlock({
      key: 'collect-instalment',
      blockId: 'lending.repay',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'apply-late-fee',
      blockId: 'lending.apply_penalty',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'trigger-collection',
      blockId: 'lending.trigger_collection',
      blockVersion: '1.0.0',
    })
    .addBlock({ key: 'notify', blockId: 'notification.send', blockVersion: '1.0.0' })

    .addBlock({ key: 'reverse-posting', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
    .addBlock({
      key: 'adjust-settlement',
      blockId: 'settlement.adjustment',
      blockVersion: '1.0.0',
    });

  composer
    .connect('start', 'authenticate', 'always')
    .branch('authenticate', 'check-eligibility', isType('PURCHASE'))
    .branch('authenticate', 'consume-instalment-limit', isType('REPAYMENT'))

    .connect('check-eligibility', 'screen-fraud')
    .connect('screen-fraud', 'consume-credit-limit')
    .connect('consume-credit-limit', 'build-plan')
    .connect('build-plan', 'disburse-to-merchant')
    .connect('disburse-to-merchant', 'post-ledger')
    .connect('post-ledger', 'settle-merchant')
    .connect('settle-merchant', 'completed')

    .connect('consume-instalment-limit', 'collect-instalment')
    .connect('collect-instalment', 'apply-late-fee')
    .connect('apply-late-fee', 'trigger-collection')
    .connect('trigger-collection', 'notify')
    .connect('notify', 'completed')

    .connect('reverse-posting', 'failed', 'always')
    .connect('adjust-settlement', 'failed', 'always');

  composer
    .addLimit({
      code: 'CREDIT_LINE',
      limitType: 'PER_TRANSACTION',
      scope: 'customer',
      amount: { minorUnits: '200000', currency: TEMPLATE_CURRENCY },
      description: 'A placeholder credit line per customer. Configure before publication.',
    })
    .addLimit({
      code: 'INSTALMENT',
      limitType: 'PER_TRANSACTION',
      scope: 'customer',
      amount: { minorUnits: '100000', currency: TEMPLATE_CURRENCY },
      description: 'A placeholder ceiling on a single instalment.',
    })
    .withRiskPolicy({
      prohibitedRiskLevels: ['PROHIBITED', 'HIGH'],
      requiredChecks: ['risk'],
      manualReviewScore: 70,
    })
    .withSettlement({ schedule: 'daily', calendar: 'BUSINESS_DAYS', cutoff: '18:00', holdDays: 0 });

  return composer.build();
}

// --- loyalty wallet ---------------------------------------------------------

/**
 * Loyalty Wallet.
 *
 * Member account, earn, redeem, expire, transfer and a campaign reward.
 *
 * Points are ledgered like any other customer balance, and that is the decision worth noticing.
 * A loyalty scheme with its own points table has a second source of truth, the two disagree
 * within a month, and the one the customer sees is the wrong one. It is also a liability: points
 * are something the business owes.
 */
export function loyaltyWalletTemplate(): ProductDefinition {
  const composer = new ProductComposer(
    baseOptions(
      'loyalty-wallet',
      'Loyalty Wallet',
      'loyalty',
      'A loyalty points wallet: earn, redeem, expire and transfer, on a ledger-backed points balance.',
    ),
  );

  composer
    .addBlock({ key: 'authenticate', blockId: 'identity.authenticate', blockVersion: '1.0.0' })
    .addBlock({
      key: 'open-member-account',
      blockId: 'loyalty.member_account',
      blockVersion: '1.0.0',
    })
    .addBlock({ key: 'apply-campaign', blockId: 'loyalty.campaign_reward', blockVersion: '1.0.0' })
    .addBlock({
      key: 'consume-points-limit',
      blockId: 'limit.velocity',
      blockVersion: '1.0.0',
      configuration: { limitCode: 'POINTS_VELOCITY' },
    })
    .addBlock({
      key: 'earn-points',
      blockId: 'loyalty.earn',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'redeem-points',
      blockId: 'loyalty.redeem',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'transfer-points',
      blockId: 'loyalty.transfer',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'expire-points',
      blockId: 'loyalty.expire',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'post-ledger',
      blockId: 'ledger.create_journal',
      blockVersion: '1.0.0',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({ key: 'notify', blockId: 'notification.send', blockVersion: '1.0.0' })
    .addBlock({ key: 'reverse-posting', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' });

  composer
    .connect('start', 'authenticate', 'always')
    .branch('authenticate', 'open-member-account', isType('ENROL'))
    .branch(
      'authenticate',
      'consume-points-limit',
      isOneOf(['EARN', 'REDEEM', 'TRANSFER', 'EXPIRE']),
    )

    .connect('open-member-account', 'apply-campaign')
    .connect('apply-campaign', 'completed')

    .branch('consume-points-limit', 'earn-points', isType('EARN'))
    .branch('consume-points-limit', 'redeem-points', isType('REDEEM'))
    .branch('consume-points-limit', 'transfer-points', isType('TRANSFER'))
    .branch('consume-points-limit', 'expire-points', isType('EXPIRE'))

    .connect('earn-points', 'post-ledger')
    .connect('redeem-points', 'post-ledger')
    .connect('transfer-points', 'post-ledger')
    .connect('expire-points', 'post-ledger')
    .connect('post-ledger', 'notify')
    .connect('notify', 'completed')

    .connect('reverse-posting', 'failed', 'always');

  composer.addLimit({
    code: 'POINTS_VELOCITY',
    limitType: 'VELOCITY',
    scope: 'customer',
    count: 50,
    windowSeconds: 86_400,
    description:
      'A placeholder ceiling on points operations per day. Configure before publication.',
  });

  return composer.build();
}

// --- the worked example -----------------------------------------------------

/**
 * Merchant Wallet Basic — the worked example from section 30.
 *
 * The one product this phase ships as a demonstration rather than as a starting point. It is
 * deliberately the simplest thing that exercises the whole layer end to end:
 *
 *   merchant verification -> create wallet -> configure limits -> accept payment -> apply fee
 *   -> post ledger -> settlement -> reconciliation
 *
 * Everything about it is configurable and nothing about it is a provider. The currency is
 * generic, the daily limit and the fee are declared rather than coded, the settlement schedule is
 * a policy, and every external call goes through `PaymentProvider` and `SettlementProvider`
 * interfaces with no connector bound — a deployment binds them.
 *
 * There is no KHQR here and no bank, and there is no extension point marked "add the bank here"
 * either. The extension point is `bindProvider`, and it is the same one every other product uses.
 */
export function merchantWalletBasicTemplate(): ProductDefinition {
  const composer = new ProductComposer({
    ...baseOptions(
      'merchant-wallet-basic',
      'Merchant Wallet Basic',
      'merchant',
      'The worked example: merchant verification, a ledger-backed wallet, a configurable daily limit and acceptance fee, settlement and reconciliation. Provider-neutral throughout.',
    ),
    auditClassification: 'sensitive',
  });

  composer
    .addBlock({
      key: 'verify-merchant',
      blockId: 'identity.customer_eligibility',
      blockVersion: '1.0.0',
      name: 'Merchant verification',
      configuration: { criteria: 'MERCHANT_STANDARD' },
    })
    .addBlock({
      key: 'create-wallet',
      blockId: 'wallet.create',
      blockVersion: '1.0.0',
      name: 'Create merchant wallet',
    })
    .addBlock({
      key: 'configure-limits',
      blockId: 'limit.daily',
      blockVersion: '1.0.0',
      name: 'Configure daily limit',
      configuration: { limitCode: 'DAILY_ACCEPTANCE' },
    })
    .addBlock({
      key: 'accept-payment',
      blockId: 'payment.execute',
      blockVersion: '1.0.0',
      name: 'Accept payment',
      timeoutMs: 20_000,
      slaMs: 30_000,
      onFailure: 'compensate',
      compensateWith: ['refund-payment'],
    })
    .addBlock({
      key: 'refund-payment',
      blockId: 'payment.refund',
      blockVersion: '1.0.0',
      name: 'Refund payment',
    })
    .addBlock({
      key: 'apply-fee',
      blockId: 'fee.percentage',
      blockVersion: '1.0.0',
      name: 'Apply acceptance fee',
      configuration: { feeCode: 'ACCEPTANCE' },
    })
    .addBlock({
      key: 'post-ledger',
      blockId: 'ledger.create_journal',
      blockVersion: '1.0.0',
      name: 'Post to the ledger',
      onFailure: 'compensate',
      compensateWith: ['reverse-posting'],
    })
    .addBlock({
      key: 'settle',
      blockId: 'settlement.create',
      blockVersion: '1.0.0',
      name: 'Create settlement',
      onFailure: 'compensate',
      compensateWith: ['adjust-settlement'],
    })
    .addBlock({
      key: 'reconcile',
      blockId: 'reconciliation.match',
      blockVersion: '1.0.0',
      name: 'Reconcile',
    })
    .addBlock({ key: 'reverse-posting', blockId: 'ledger.reverse_journal', blockVersion: '1.0.0' })
    .addBlock({
      key: 'adjust-settlement',
      blockId: 'settlement.adjustment',
      blockVersion: '1.0.0',
    });

  composer
    .connect('start', 'verify-merchant', 'always')
    .connect('verify-merchant', 'create-wallet')
    .connect('create-wallet', 'configure-limits')
    .connect('configure-limits', 'accept-payment')
    .connect('accept-payment', 'apply-fee')
    .connect('apply-fee', 'post-ledger')
    .connect('post-ledger', 'settle')
    .connect('settle', 'reconcile')
    .connect('reconcile', 'completed')
    /*
     * The compensators end the execution.
     *
     * Every compensating block needs somewhere to go — an execution that reaches one and stops
     * has unwound something and never said so. `failed` is the honest terminus: the transaction
     * did not happen, and the ledger is square again.
     */
    .connect('refund-payment', 'failed', 'always')
    .connect('reverse-posting', 'failed', 'always')
    .connect('adjust-settlement', 'failed', 'always');

  composer
    .addFee({
      code: 'ACCEPTANCE',
      feeType: 'PERCENTAGE',
      basis: 'percentage',
      rate: { hundredthsOfBasisPoint: '5000' },
      bearer: 'payee',
      rounding: 'half_even',
      description: '0.5%, borne by the merchant. Configurable.',
    })
    .addLimit({
      code: 'DAILY_ACCEPTANCE',
      limitType: 'DAILY',
      scope: 'merchant',
      amount: { minorUnits: '500000', currency: TEMPLATE_CURRENCY },
      description: 'A configurable daily acceptance ceiling.',
    })
    .withRiskPolicy({
      enhancedReviewAbove: { minorUnits: '200000', currency: TEMPLATE_CURRENCY },
      prohibitedRiskLevels: ['PROHIBITED'],
      requiredChecks: [],
    })
    .withSettlement({ schedule: 'daily', calendar: 'BUSINESS_DAYS', cutoff: '18:00', holdDays: 1 })
    .withReconciliation({
      frequency: 'daily',
      toleranceMinorUnits: '0',
      exceptionSlaHours: 24,
      blocksSettlement: true,
    })
    .addRule({
      id: 'enhanced-review-above-threshold',
      description:
        'Anything above the configured threshold gets an enhanced review before it completes.',
      priority: 10,
      enabled: true,
      when: { field: 'amountMinorUnits', operator: 'gt', value: 200_000 },
      then: [
        {
          kind: 'require_review',
          level: 'COMPLIANCE',
          reason: 'Above the enhanced-review threshold.',
        },
      ],
    })
    .expose({
      exposed: true,
      operations: [
        {
          operationId: 'onboardMerchant',
          method: 'POST',
          path: '/onboard',
          permission: 'financial.product.execute',
          entryBlock: 'verify-merchant',
          createsTransaction: false,
          requiresIdempotencyKey: true,
          rateLimitPerMinute: 60,
          description: 'Verifies a merchant and opens a wallet.',
        },
        {
          operationId: 'acceptPayment',
          method: 'POST',
          path: '/payments',
          permission: 'financial.product.execute',
          entryBlock: 'accept-payment',
          createsTransaction: true,
          requiresIdempotencyKey: true,
          rateLimitPerMinute: 600,
          description: 'Accepts a payment, applies the fee and posts to the ledger.',
        },
        {
          operationId: 'getExecution',
          method: 'GET',
          path: '/executions/:executionId',
          permission: 'financial.product.execution.read',
          createsTransaction: false,
          requiresIdempotencyKey: false,
          description: 'Reads the status of one execution.',
        },
      ],
      authentication: ['bearer', 'api_key'],
    });

  return composer.build();
}

export interface ProductTemplate {
  id: string;
  name: string;
  description: string;
  build: () => ProductDefinition;
}

/** The template library. Local data — there is no remote fetch and no plugin resolution. */
export const PRODUCT_TEMPLATES: readonly ProductTemplate[] = Object.freeze([
  {
    id: 'consumer-wallet',
    name: 'Consumer Wallet',
    description: 'Onboarding, cash-in, person-to-person, merchant payment and cash-out.',
    build: consumerWalletTemplate,
  },
  {
    id: 'merchant-wallet',
    name: 'Merchant Wallet',
    description:
      'Business verification, payment acceptance, refund, settlement and reconciliation.',
    build: merchantWalletTemplate,
  },
  {
    id: 'microloan',
    name: 'Microloan',
    description:
      'Eligibility, an external credit assessment, disbursement, repayment and collection.',
    build: microloanTemplate,
  },
  {
    id: 'bnpl',
    name: 'Buy Now, Pay Later',
    description: 'A credit line, an instalment plan, immediate merchant settlement and repayment.',
    build: bnplTemplate,
  },
  {
    id: 'loyalty-wallet',
    name: 'Loyalty Wallet',
    description: 'Earn, redeem, expire and transfer, on a ledger-backed points balance.',
    build: loyaltyWalletTemplate,
  },
  {
    id: 'merchant-wallet-basic',
    name: 'Merchant Wallet Basic',
    description: 'The worked example: the whole layer end to end, provider-neutral throughout.',
    build: merchantWalletBasicTemplate,
  },
]);

export function findTemplate(id: string): ProductTemplate | undefined {
  return PRODUCT_TEMPLATES.find((template) => template.id === id);
}
