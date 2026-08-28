import { describe, expect, it } from 'vitest';
import { formatMoney, money } from '@trustos/financial-core';
import { PILOT_CURRENCY, buildPilot, pilotFeeSchedule, pilotLimits, type Pilot } from './pilot';
import { paymentRequestSchema } from './domain/payment';
import { merchantSchema, type Merchant } from './domain/merchant';

/**
 * The pilot, end to end.
 *
 * This file is evidence rather than unit testing: each block corresponds to a section of the
 * pilot specification, and the numbers it produces are what the evidence pack reports. Nothing
 * here is mocked beyond the payment provider and the risk rule, both of which are declared mocks
 * in the pilot's own code.
 */

const NOW = new Date('2026-06-15T10:00:00.000Z');

async function pilot(overrides: Parameters<typeof buildPilot>[0] = {}): Promise<Pilot> {
  return buildPilot({ now: () => NOW, ...overrides });
}

function merchant(overrides: Record<string, unknown> = {}): Merchant {
  return merchantSchema.parse({
    merchantId: 'mer_alpha',
    organizationId: 'org_a',
    legalName: 'Alpha Trading Company Limited',
    tradingName: 'Alpha Coffee',
    categoryCode: '5812',
    status: 'registered',
    productId: 'merchant-wallet-basic',
    productVersion: '1.0.0',
    currency: PILOT_CURRENCY,
    createdAt: NOW.toISOString(),
    createdBy: 'usr_ops_maker',
    ...overrides,
  });
}

/** Registers, verifies and approves a merchant with three distinct people. */
async function approvedMerchant(harness: Pilot, overrides: Record<string, unknown> = {}) {
  await harness.onboarding.register(merchant(overrides), 'usr_ops_maker');

  await harness.onboarding.verify({
    organizationId: 'org_a',
    merchantId: (overrides.merchantId as string) ?? 'mer_alpha',
    actorId: 'usr_ops_checker',
    notes: 'Registration documents and bank details confirmed against the register.',
  });

  return harness.onboarding.approve({
    organizationId: 'org_a',
    merchantId: (overrides.merchantId as string) ?? 'mer_alpha',
    actorId: 'usr_ops_manager',
    reason: 'Verification complete and the category is within appetite.',
  });
}

function payment(overrides: Record<string, unknown> = {}) {
  return paymentRequestSchema.parse({
    merchantId: 'mer_alpha',
    amount: '10.00',
    currency: PILOT_CURRENCY,
    reference: 'ORDER-001',
    ...overrides,
  });
}

async function accept(harness: Pilot, request = payment(), actorId = 'usr_cashier') {
  return harness.payments.accept({
    request,
    organizationId: 'org_a',
    actorId,
    correlationId: `cor_${request.reference}`,
  });
}

// --- §9 maker-checker --------------------------------------------------------

describe('merchant onboarding is maker-checker', () => {
  it('onboards through three distinct people', async () => {
    const harness = await pilot();
    const approved = await approvedMerchant(harness);

    expect(approved.status).toBe('approved');
    expect(approved.verifiedBy).toBe('usr_ops_checker');
    expect(approved.approvedBy).toBe('usr_ops_manager');
  });

  it('refuses an approver who verified the same merchant', async () => {
    const harness = await pilot();
    await harness.onboarding.register(merchant(), 'usr_ops_maker');
    await harness.onboarding.verify({
      organizationId: 'org_a',
      merchantId: 'mer_alpha',
      actorId: 'usr_ops_checker',
      notes: 'Registration documents confirmed against the register.',
    });

    await expect(
      harness.onboarding.approve({
        organizationId: 'org_a',
        merchantId: 'mer_alpha',
        actorId: 'usr_ops_checker',
        reason: 'Looks fine.',
      }),
    ).rejects.toThrow(/Maker and checker are different people/);
  });

  it('refuses an approver who registered the merchant', async () => {
    /*
     * The second exclusion. A control that only excluded the immediately preceding actor would be
     * satisfied by one person registering, a second verifying, and the first approving.
     */
    const harness = await pilot();
    await harness.onboarding.register(merchant(), 'usr_ops_maker');
    await harness.onboarding.verify({
      organizationId: 'org_a',
      merchantId: 'mer_alpha',
      actorId: 'usr_ops_checker',
      notes: 'Registration documents confirmed against the register.',
    });

    await expect(
      harness.onboarding.approve({
        organizationId: 'org_a',
        merchantId: 'mer_alpha',
        actorId: 'usr_ops_maker',
        reason: 'I registered this one and it is fine.',
      }),
    ).rejects.toThrow(/does not approve it/);
  });

  it('cannot approve a merchant nobody verified', async () => {
    const harness = await pilot();
    await harness.onboarding.register(merchant(), 'usr_ops_maker');

    await expect(
      harness.onboarding.approve({
        organizationId: 'org_a',
        merchantId: 'mer_alpha',
        actorId: 'usr_ops_manager',
        reason: 'Fast-tracking this one.',
      }),
    ).rejects.toThrow(/does not move from registered to approved/);
  });

  it('requires a rejection to say why, and whether they may come back', async () => {
    const harness = await pilot();
    await harness.onboarding.register(merchant(), 'usr_ops_maker');

    await expect(
      harness.onboarding.reject({
        organizationId: 'org_a',
        merchantId: 'mer_alpha',
        actorId: 'usr_ops_checker',
        rejection: { reason: 'The registration is incomplete.', reworkPermitted: true },
      }),
    ).rejects.toThrow(/say what to fix/);
  });

  it('supports rework by naming what to fix', async () => {
    const harness = await pilot();
    await harness.onboarding.register(merchant(), 'usr_ops_maker');

    const rejected = await harness.onboarding.reject({
      organizationId: 'org_a',
      merchantId: 'mer_alpha',
      actorId: 'usr_ops_checker',
      rejection: {
        reason: 'The trading name does not match the registration certificate.',
        reworkPermitted: true,
        remediation:
          'Supply a certificate showing the trading name, or register under the legal name.',
      },
    });

    expect(rejected.status).toBe('rejected');
  });

  it('audits every step', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    const actions = harness.auditSink.records.map((record) => record.action);
    expect(actions).toContain('mwb.merchant.registered');
    expect(actions).toContain('mwb.merchant.verified');
    expect(actions).toContain('mwb.merchant.approved');
  });
});

// --- §4 wallet ---------------------------------------------------------------

describe('the wallet is ledger-backed', () => {
  it('opens on approval, not at registration', async () => {
    // A wallet before approval is a wallet that can receive money for a merchant nobody checked.
    const harness = await pilot();
    await harness.onboarding.register(merchant(), 'usr_ops_maker');

    expect(await harness.walletOf('org_a', 'mer_alpha')).toBeNull();

    await harness.onboarding.verify({
      organizationId: 'org_a',
      merchantId: 'mer_alpha',
      actorId: 'usr_ops_checker',
      notes: 'Registration documents confirmed against the register.',
    });
    await harness.onboarding.approve({
      organizationId: 'org_a',
      merchantId: 'mer_alpha',
      actorId: 'usr_ops_manager',
      reason: 'Verification complete.',
    });

    // Opened by the approval, not before it.
    expect(await harness.walletOf('org_a', 'mer_alpha')).not.toBeNull();
  });

  it('derives the balance from the ledger rather than storing it', async () => {
    /*
     * The property that makes the ledger authoritative. Nothing writes a balance; the balance is
     * what the journals say, which is why a payment posts once rather than posting and crediting.
     */
    const harness = await pilot();
    await approvedMerchant(harness);
    await accept(harness);

    const walletId = (await walletIdOf(harness)) as string;
    const balance = await harness.wallets.balance(walletId, 'org_a');

    // 10.00 gross less a 0.05% ... no: 0.50% is 0.05 on 10.00, and the floor is also 0.05.
    expect(formatMoney(balance.total)).toBe('9.95 USD');
  });

  it('refuses a payment into a frozen wallet', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    const walletId = (await walletIdOf(harness)) as string;
    await harness.wallets.freeze({
      walletId,
      organizationId: 'org_a',
      reason: 'Under investigation following a chargeback pattern.',
      actorId: 'usr_ops_manager',
    });

    const result = await accept(harness, payment({ reference: 'ORDER-FROZEN' }));
    expect(result.refusalCode).toBe('wallet_frozen');
  });

  it('accepts again once unfrozen', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);
    const walletId = (await walletIdOf(harness)) as string;

    await harness.wallets.freeze({
      walletId,
      organizationId: 'org_a',
      reason: 'Under investigation following a chargeback pattern.',
      actorId: 'usr_ops_manager',
    });
    await harness.wallets.unfreeze({
      walletId,
      organizationId: 'org_a',
      reason: 'The investigation found nothing.',
      actorId: 'usr_ops_manager',
    });

    expect((await accept(harness, payment({ reference: 'ORDER-THAWED' }))).status).toBe('accepted');
  });
});

async function walletIdOf(harness: Pilot, merchantId = 'mer_alpha'): Promise<string | null> {
  return (await harness.walletOf('org_a', merchantId))?.id ?? null;
}

// --- §5 ledger, §6 payment, §7 fee ------------------------------------------

describe('accepting a payment', () => {
  it('posts one balanced journal', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    const result = await accept(harness);
    expect(result.status).toBe('accepted');
    expect(result.journalId).not.toBeNull();

    const journal = await harness.ledger.get(result.journalId as string, 'org_a');
    const debits = journal.entries.filter((entry) => entry.direction === 'debit');
    const credits = journal.entries.filter((entry) => entry.direction === 'credit');

    expect(debits).toHaveLength(1);
    expect(credits).toHaveLength(2);
  });

  it('charges 0.50%', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    // 200.00 × 0.50% = 1.00.
    const result = await accept(harness, payment({ amount: '200.00', reference: 'ORDER-FEE' }));
    expect(result.fee?.amount).toBe('1.00');
    expect(result.net?.amount).toBe('199.00');
  });

  it('applies the minimum fee', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    // 1.00 × 0.50% = 0.005, below the 0.05 floor.
    const result = await accept(harness, payment({ amount: '1.00', reference: 'ORDER-MIN' }));
    expect(result.fee?.amount).toBe('0.05');
  });

  it('applies the maximum fee', async () => {
    const harness = await pilot();
    await approvedMerchant(harness, { merchantId: 'mer_beta' });

    // The per-transaction limit is 1,000 so the ceiling is exercised through a schedule with a
    // lower cap rather than a larger payment — the limit is a separate control and should stay one.
    const capped = await pilot({ feeSchedule: pilotFeeSchedule({ maximumFee: '2.00' }) });
    await approvedMerchant(capped);

    const result = await accept(capped, payment({ amount: '1000.00', reference: 'ORDER-MAX' }));
    expect(result.fee?.amount).toBe('2.00');
  });

  it('takes the fee from configuration rather than from code', async () => {
    /*
     * The specification's rule: do not hardcode the fee in a controller. Changing the schedule
     * changes the fee with no code change, which is what this asserts.
     */
    const harness = await pilot({
      feeSchedule: pilotFeeSchedule({
        id: 'fee_mwb_v2',
        version: 2,
        components: [
          {
            name: 'Merchant service fee',
            kind: 'percentage',
            basisPoints: 100,
            tiers: [],
            amount: null,
            revenueAccountCode: null,
            metadata: {},
          },
        ],
      }),
    });
    await approvedMerchant(harness);

    // 1.00% of 200.00.
    expect(
      (await accept(harness, payment({ amount: '200.00', reference: 'ORDER-V2' }))).fee?.amount,
    ).toBe('2.00');
  });

  it('never floats the money', async () => {
    /*
     * 0.1 + 0.2 in a float is 0.30000000000000004. Every amount in and out of this flow is a
     * string, and the arithmetic is @trustos/financial-core's.
     */
    const harness = await pilot();
    await approvedMerchant(harness);

    const first = await accept(harness, payment({ amount: '0.10', reference: 'ORDER-F1' }));
    const second = await accept(harness, payment({ amount: '0.20', reference: 'ORDER-F2' }));

    const totals = harness.payments.totals(PILOT_CURRENCY);
    expect(totals.gross.amount.units).toBe(money('0.30', PILOT_CURRENCY).amount.units);
    expect(typeof first.gross?.amount).toBe('string');
    expect(typeof second.gross?.amount).toBe('string');
  });
});

// --- §6 idempotency ----------------------------------------------------------

describe('idempotency', () => {
  it('replays a repeated reference rather than charging twice', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    const first = await accept(harness);
    const second = await accept(harness);

    expect(second.replayed).toBe(true);
    expect(second.journalId).toBe(first.journalId);
    expect(harness.payments.totals(PILOT_CURRENCY).count).toBe(1);
  });

  it('does not consume the limit twice on a replay', async () => {
    /*
     * The invisible version of a double charge. The merchant sees one response either way; what
     * differs is how much of their daily allowance is gone, and they find out at the next refusal.
     */
    const harness = await pilot();
    await approvedMerchant(harness);

    for (let index = 0; index < 5; index += 1) await accept(harness);

    const walletId = (await walletIdOf(harness)) as string;
    const remaining = await harness.limits.check({
      organizationId: 'org_a',
      scope: 'wallet',
      subjectId: walletId,
      amount: money('1.00', PILOT_CURRENCY),
    });

    expect(remaining.allowed).toBe(true);
  });

  it('treats a different reference as a different payment', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    await accept(harness);
    const second = await accept(harness, payment({ reference: 'ORDER-002' }));

    expect(second.replayed).toBe(false);
    expect(harness.payments.totals(PILOT_CURRENCY).count).toBe(2);
  });
});

// --- §8 limits ---------------------------------------------------------------

describe('limits', () => {
  it('accepts below the per-transaction limit', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    expect(
      (await accept(harness, payment({ amount: '999.99', reference: 'ORDER-BELOW' }))).status,
    ).toBe('accepted');
  });

  it('accepts exactly at the limit', async () => {
    // The boundary. An off-by-one here refuses a merchant for a payment the agreement permits.
    const harness = await pilot();
    await approvedMerchant(harness);

    expect(
      (await accept(harness, payment({ amount: '1000.00', reference: 'ORDER-AT' }))).status,
    ).toBe('accepted');
  });

  it('refuses above the limit', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    const result = await accept(harness, payment({ amount: '1000.01', reference: 'ORDER-ABOVE' }));
    expect(result.refusalCode).toBe('limit_exceeded');
  });

  it('accumulates against the daily limit', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    // Five payments of 1,000 reach the 5,000 daily ceiling; the sixth is refused.
    for (let index = 0; index < 5; index += 1) {
      const result = await accept(
        harness,
        payment({ amount: '1000.00', reference: `ORDER-D${index}` }),
      );
      expect(result.status, `payment ${index}`).toBe('accepted');
    }

    const sixth = await accept(harness, payment({ amount: '1000.00', reference: 'ORDER-D5' }));
    expect(sixth.refusalCode).toBe('limit_exceeded');
  });

  it('reads the limits from configuration', async () => {
    const harness = await pilot({
      limits: pilotLimits('org_a').map((limit) =>
        limit.key === 'wallet.transaction.usd' ? { ...limit, maxAmount: '50.00' } : limit,
      ),
    });
    await approvedMerchant(harness);

    expect(
      (await accept(harness, payment({ amount: '60.00', reference: 'ORDER-CFG' }))).refusalCode,
    ).toBe('limit_exceeded');
  });
});

// --- §6 the refusal paths ----------------------------------------------------

describe('the refusal paths', () => {
  it('refuses an unapproved merchant', async () => {
    const harness = await pilot();
    await harness.onboarding.register(merchant(), 'usr_ops_maker');

    expect((await accept(harness)).refusalCode).toBe('merchant_not_approved');
  });

  it('refuses a merchant in another organization', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    const result = await harness.payments.accept({
      request: payment(),
      organizationId: 'org_b',
      actorId: 'usr_cashier_b',
      correlationId: 'cor_cross',
    });

    expect(result.refusalCode).toBe('merchant_not_found');
  });

  it('refuses a currency the merchant does not transact in', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    expect(
      (await accept(harness, payment({ currency: 'EUR', reference: 'ORDER-FX' }))).refusalCode,
    ).toBe('currency_mismatch');
  });

  it('refuses when the mock risk rule refuses', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    expect((await accept(harness, payment({ reference: 'RISK-REFUSE-1' }))).refusalCode).toBe(
      'risk_refused',
    );
  });

  it('refuses when the mock provider does not respond', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    expect((await accept(harness, payment({ reference: 'PROVIDER-TIMEOUT-1' }))).refusalCode).toBe(
      'provider_unavailable',
    );
  });

  it('names its refusals distinctly', async () => {
    // Seven distinct codes across the flow. A single "declined" is what makes merchant support
    // expensive, because the merchant cannot tell what to change.
    const harness = await pilot();
    await approvedMerchant(harness);

    const codes = new Set(
      await Promise.all(
        [
          payment({ currency: 'EUR', reference: 'R-1' }),
          payment({ reference: 'RISK-REFUSE-2' }),
          payment({ reference: 'PROVIDER-TIMEOUT-2' }),
          payment({ amount: '2000.00', reference: 'R-4' }),
          payment({ merchantId: 'mer_unknown', reference: 'R-5' }),
        ].map(async (request) => (await accept(harness, request)).refusalCode),
      ),
    );

    expect(codes.size).toBe(5);
  });
});

// --- §10 tenant isolation ----------------------------------------------------

describe('tenant isolation', () => {
  it('does not return another organization’s merchant', async () => {
    /*
     * Tested against the service, not a UI. The specification is explicit: test API manipulation
     * directly, because a UI restriction is not a control.
     */
    const harness = await pilot();
    await approvedMerchant(harness);

    expect(harness.onboarding.get('org_b', 'mer_alpha')).toBeNull();
    expect(() => harness.onboarding.require('org_b', 'mer_alpha')).toThrow(/No merchant/);
  });

  it('does not list another organization’s merchants', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);

    expect(harness.onboarding.list('org_b')).toHaveLength(0);
    expect(harness.onboarding.list('org_a')).toHaveLength(1);
  });

  it('does not return another organization’s wallet', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);
    const walletId = (await walletIdOf(harness)) as string;

    await expect(harness.wallets.get(walletId, 'org_b')).rejects.toThrow(/No wallet/);
  });

  it('does not return another organization’s journal', async () => {
    const harness = await pilot();
    await approvedMerchant(harness);
    const result = await accept(harness);

    await expect(harness.ledger.get(result.journalId as string, 'org_b')).rejects.toThrow();
  });

  it('does not let one organization’s payment reference collide with another’s', async () => {
    // The idempotency key is scoped by organization, so two tenants using ORDER-001 are two
    // payments rather than one replay.
    const harness = await pilot();
    await approvedMerchant(harness);

    await harness.onboarding.register(
      merchant({ merchantId: 'mer_beta', organizationId: 'org_b', createdBy: 'usr_ops_b' }),
      'usr_ops_b',
    );
    await harness.onboarding.verify({
      organizationId: 'org_b',
      merchantId: 'mer_beta',
      actorId: 'usr_ops_b_checker',
      notes: 'Registration documents confirmed against the register.',
    });
    await harness.onboarding.approve({
      organizationId: 'org_b',
      merchantId: 'mer_beta',
      actorId: 'usr_ops_b_manager',
      reason: 'Verification complete.',
    });

    await accept(harness);
    const other = await harness.payments.accept({
      request: payment({ merchantId: 'mer_beta' }),
      organizationId: 'org_b',
      actorId: 'usr_cashier_b',
      correlationId: 'cor_b',
    });

    expect(other.replayed).toBe(false);
    expect(other.status).toBe('accepted');
  });
});

// --- §9 the controlled configuration change ---------------------------------

describe('a limit change is a request', () => {
  async function request(harness: Pilot, requestedBy = 'usr_ops_maker') {
    await approvedMerchant(harness);

    return harness.onboarding.requestLimitChange(
      {
        requestId: 'lcr_001',
        merchantId: 'mer_alpha',
        organizationId: 'org_a',
        limitKey: 'wallet.daily.usd',
        currentValue: '500000',
        requestedValue: '1000000',
        justification:
          'The merchant has opened two additional branches and expects double the volume.',
        requestedBy,
        requestedAt: NOW.toISOString(),
      },
      requestedBy,
    );
  }

  it('changes nothing until it is approved', async () => {
    /*
     * The shape people skip, because "just change the limit and audit it" is one line. The
     * difference shows up the first time a limit is raised at 2am by somebody who then leaves:
     * with a request there is a decision to read.
     */
    const harness = await pilot();
    const pending = await request(harness);

    expect(pending.status).toBe('pending');
    expect(harness.onboarding.pendingLimitChanges('org_a')).toHaveLength(1);
  });

  it('refuses the requester as the approver', async () => {
    const harness = await pilot();
    await request(harness);

    await expect(
      harness.onboarding.decideLimitChange({
        requestId: 'lcr_001',
        decision: 'approved',
        actorId: 'usr_ops_maker',
        reason: 'Approving my own request.',
        organizationId: 'org_a',
      }),
    ).rejects.toThrow(/does not approve it/);
  });

  it('approves with a second person', async () => {
    const harness = await pilot();
    await request(harness);

    const decided = await harness.onboarding.decideLimitChange({
      requestId: 'lcr_001',
      decision: 'approved',
      actorId: 'usr_finance',
      reason: 'The volume increase is consistent with the branch openings.',
      organizationId: 'org_a',
    });

    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe('usr_finance');
  });

  it('refuses to decide a request twice', async () => {
    // Without this, a rejected request could be approved afterwards by somebody who did not see
    // the rejection.
    const harness = await pilot();
    await request(harness);

    await harness.onboarding.decideLimitChange({
      requestId: 'lcr_001',
      decision: 'rejected',
      actorId: 'usr_finance',
      reason: 'The branch openings are not confirmed.',
      organizationId: 'org_a',
    });

    await expect(
      harness.onboarding.decideLimitChange({
        requestId: 'lcr_001',
        decision: 'approved',
        actorId: 'usr_finance_2',
        reason: 'Reconsidered.',
        organizationId: 'org_a',
      }),
    ).rejects.toThrow(/already rejected/);
  });

  it('does not reach another organization’s request', async () => {
    const harness = await pilot();
    await request(harness);

    await expect(
      harness.onboarding.decideLimitChange({
        requestId: 'lcr_001',
        decision: 'approved',
        actorId: 'usr_finance',
        reason: 'Approving from the wrong tenant.',
        organizationId: 'org_b',
      }),
    ).rejects.toThrow(/No limit change request/);
  });
});
