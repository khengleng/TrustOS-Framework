import { describe, expect, it } from 'vitest';
import { money } from '@trustsystem/financial-core';
import { scopeSatisfies } from '@trustsystem/api-keys';
import {
  MERCHANT_ROLES,
  ROLE_CAPABILITIES,
  assertCanView,
  canView,
  merchantSchema,
  type Merchant,
} from './domain/merchant';
import {
  PILOT_PERMISSIONS,
  ROLE_PERMISSIONS,
  SEGREGATED_PAIRS,
  WRITE_PERMISSIONS,
  capabilityMatchesGrant,
  merchantRoleGrants,
  segregationViolations,
} from './permissions';
import { PILOT_CURRENCY, buildPilot, type Pilot } from './pilot';
import { paymentRequestSchema } from './domain/payment';

/**
 * §21 of the pilot specification: the security tests, all of them negative.
 *
 * Each asserts that a bypass is **refused**, and each is written against the service rather than a
 * UI. The specification is explicit about that — *test API manipulation directly, do not only test
 * UI restrictions* — and the reason is that a hidden button is a request anybody can still make.
 *
 * Where a control lives in the framework rather than in the pilot, the test says so. The point of
 * the pilot is that most of them do.
 */

const NOW = new Date('2026-06-15T10:00:00.000Z');

async function pilot(): Promise<Pilot> {
  return buildPilot({ now: () => NOW });
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

async function approved(harness: Pilot, overrides: Record<string, unknown> = {}) {
  const merchantId = (overrides.merchantId as string) ?? 'mer_alpha';
  const organizationId = (overrides.organizationId as string) ?? 'org_a';

  await harness.onboarding.register(
    merchant(overrides),
    (overrides.createdBy as string) ?? 'usr_ops_maker',
  );
  await harness.onboarding.verify({
    organizationId,
    merchantId,
    actorId: 'usr_ops_checker',
    notes: 'Registration documents and bank details confirmed against the register.',
  });

  return harness.onboarding.approve({
    organizationId,
    merchantId,
    actorId: 'usr_ops_manager',
    reason: 'Verification complete and the category is within appetite.',
  });
}

function payment(overrides: Record<string, unknown> = {}) {
  return paymentRequestSchema.parse({
    merchantId: 'mer_alpha',
    amount: '10.00',
    currency: PILOT_CURRENCY,
    reference: 'ORDER-SEC',
    ...overrides,
  });
}

// --- authorization and role escalation --------------------------------------

describe('authorization', () => {
  it('gives the auditor no write permission at all', () => {
    /*
     * The role most often given a write permission "so they can annotate". An audit role that can
     * change something can change what it audits.
     */
    const held = new Set(ROLE_PERMISSIONS.auditor);

    for (const permission of WRITE_PERMISSIONS) {
      expect(held.has(permission), permission).toBe(false);
    }
  });

  it('gives the cashier no settlement, ledger or limit access', () => {
    // The narrowest role. A cashier takes payments; they do not see what the business earns.
    const held = new Set(ROLE_PERMISSIONS.cashier);

    expect(held.has(PILOT_PERMISSIONS.SETTLEMENT_READ.key)).toBe(false);
    expect(held.has(PILOT_PERMISSIONS.LEDGER_READ.key)).toBe(false);
    expect(held.has(PILOT_PERMISSIONS.LIMIT_READ.key)).toBe(false);
  });

  it('matches every role’s declared capability to what it actually holds', () => {
    // A role documented as read-only that holds a write permission is a documentation lie, and
    // documentation is what a reviewer reads.
    for (const role of MERCHANT_ROLES) {
      expect(capabilityMatchesGrant(role), role).toBe(true);
    }
  });

  it('lets no role hold both halves of a maker-checker pair', () => {
    expect(segregationViolations(merchantRoleGrants())).toEqual([]);
  });

  it('would catch a role that was given both', () => {
    // The test above passes vacuously if the checker is broken, so the checker is checked.
    const violations = segregationViolations([
      {
        name: 'ops_superuser',
        permissions: [
          PILOT_PERMISSIONS.MERCHANT_VERIFY.key,
          PILOT_PERMISSIONS.MERCHANT_APPROVE.key,
        ],
      },
    ]);

    expect(violations).toHaveLength(1);
  });

  it('names three pairs', () => {
    expect(SEGREGATED_PAIRS).toHaveLength(3);
  });
});

// --- self-approval -----------------------------------------------------------

describe('self-approval', () => {
  it('refuses the verifier as the approver', async () => {
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
        reason: 'I verified it, so it is fine.',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses the requester as the limit approver', async () => {
    const harness = await pilot();
    await approved(harness);

    await harness.onboarding.requestLimitChange(
      {
        requestId: 'lcr_sec',
        merchantId: 'mer_alpha',
        organizationId: 'org_a',
        limitKey: 'wallet.daily.usd',
        currentValue: '500000',
        requestedValue: '5000000',
        justification: 'A tenfold increase requested to cover a seasonal promotion this weekend.',
        requestedBy: 'usr_ops_maker',
        requestedAt: NOW.toISOString(),
      },
      'usr_ops_maker',
    );

    await expect(
      harness.onboarding.decideLimitChange({
        requestId: 'lcr_sec',
        decision: 'approved',
        actorId: 'usr_ops_maker',
        reason: 'Approving my own tenfold increase.',
        organizationId: 'org_a',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('records who acted at each step, so the refusal is checkable afterwards', async () => {
    const harness = await pilot();
    const record = await approved(harness);

    expect(record.createdBy).toBe('usr_ops_maker');
    expect(record.verifiedBy).toBe('usr_ops_checker');
    expect(record.approvedBy).toBe('usr_ops_manager');
    expect(new Set([record.createdBy, record.verifiedBy, record.approvedBy]).size).toBe(3);
  });
});

// --- cross-tenant access -----------------------------------------------------

describe('cross-tenant access', () => {
  it('refuses a merchant read from another organization', async () => {
    const harness = await pilot();
    await approved(harness);

    expect(harness.onboarding.get('org_b', 'mer_alpha')).toBeNull();
  });

  it('refuses a wallet read from another organization', async () => {
    const harness = await pilot();
    await approved(harness);
    const wallet = await harness.walletOf('org_a', 'mer_alpha');

    await expect(harness.wallets.get(wallet?.id as string, 'org_b')).rejects.toThrow();
  });

  it('refuses a journal read from another organization', async () => {
    const harness = await pilot();
    await approved(harness);

    const result = await harness.payments.accept({
      request: payment(),
      organizationId: 'org_a',
      actorId: 'usr_cashier',
      correlationId: 'cor_sec',
    });

    await expect(harness.ledger.get(result.journalId as string, 'org_b')).rejects.toThrow();
  });

  it('does not let a platform-wide role cross an organization boundary', () => {
    /*
     * The check that matters most in the role model. `finance` and `operations` see other
     * *merchants*; neither sees another *tenant*, because a tenant boundary is not a permission.
     */
    const target = merchant({
      status: 'approved',
      verifiedBy: 'usr_v',
      verifiedAt: NOW.toISOString(),
    });

    for (const role of MERCHANT_ROLES) {
      expect(
        canView({ viewer: { organizationId: 'org_b', role, merchantId: null }, merchant: target }),
        role,
      ).toBe(false);
    }
  });

  it('lets a platform role see another merchant inside its own tenant', () => {
    const target = merchant({
      status: 'approved',
      verifiedBy: 'usr_v',
      verifiedAt: NOW.toISOString(),
    });

    expect(
      canView({
        viewer: { organizationId: 'org_a', role: 'operations', merchantId: 'mer_other' },
        merchant: target,
      }),
    ).toBe(true);
  });

  it('does not let a merchant role see another merchant', () => {
    const target = merchant({
      status: 'approved',
      verifiedBy: 'usr_v',
      verifiedAt: NOW.toISOString(),
    });

    expect(
      canView({
        viewer: { organizationId: 'org_a', role: 'merchant_owner', merchantId: 'mer_other' },
        merchant: target,
      }),
    ).toBe(false);
  });

  it('answers a cross-tenant read with not-found rather than forbidden', () => {
    /*
     * Confirming that a merchant exists in another organization is itself a disclosure: it tells a
     * caller the identifier they guessed is real.
     */
    const target = merchant({
      status: 'approved',
      verifiedBy: 'usr_v',
      verifiedAt: NOW.toISOString(),
    });

    try {
      assertCanView({
        viewer: { organizationId: 'org_b', role: 'operations', merchantId: null },
        merchant: target,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { code: string }).code).toBe('not_found');
    }
  });
});

// --- IDOR --------------------------------------------------------------------

describe('IDOR', () => {
  it('does not accept a merchant id alone as authorization', async () => {
    /*
     * Every read in the pilot takes `organizationId` first and non-optionally. A lookup by id that
     * then filters is a lookup that returns the wrong thing when somebody forgets the filter, and
     * the signature makes forgetting it a type error.
     */
    const harness = await pilot();
    await approved(harness);

    expect(() => harness.onboarding.require('org_b', 'mer_alpha')).toThrow(/No merchant/);
  });

  it('does not let a payment name a merchant in another tenant', async () => {
    const harness = await pilot();
    await approved(harness);

    const result = await harness.payments.accept({
      request: payment({ reference: 'ORDER-IDOR' }),
      organizationId: 'org_b',
      actorId: 'usr_attacker',
      correlationId: 'cor_idor',
    });

    expect(result.refusalCode).toBe('merchant_not_found');
  });
});

// --- duplicate transactions and idempotency ---------------------------------

describe('duplicate transactions', () => {
  it('does not charge twice for a repeated reference', async () => {
    const harness = await pilot();
    await approved(harness);

    const accept = () =>
      harness.payments.accept({
        request: payment({ reference: 'ORDER-DUP' }),
        organizationId: 'org_a',
        actorId: 'usr_cashier',
        correlationId: 'cor_dup',
      });

    const first = await accept();
    const second = await accept();

    expect(second.replayed).toBe(true);
    expect(second.journalId).toBe(first.journalId);
    expect(harness.payments.totals(PILOT_CURRENCY).count).toBe(1);
  });

  it('does not let concurrent duplicates both execute', async () => {
    /*
     * The version that is actually hard. A client whose connection drops retries immediately, and
     * the two requests overlap.
     */
    const harness = await pilot();
    await approved(harness);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.payments.accept({
          request: payment({ reference: 'ORDER-RACE' }),
          organizationId: 'org_a',
          actorId: 'usr_cashier',
          correlationId: 'cor_race',
        }),
      ),
    );

    const journalIds = new Set(results.filter((r) => r.journalId).map((r) => r.journalId));
    expect(journalIds.size).toBe(1);
  });

  it('does not let a different tenant replay another’s reference', async () => {
    // The idempotency key is scoped by organization, so ORDER-001 in two tenants is two payments.
    const harness = await pilot();
    await approved(harness);
    await approved(harness, {
      merchantId: 'mer_beta',
      organizationId: 'org_b',
      createdBy: 'usr_ops_b',
    });

    await harness.payments.accept({
      request: payment({ reference: 'ORDER-SHARED' }),
      organizationId: 'org_a',
      actorId: 'usr_cashier',
      correlationId: 'cor_a',
    });

    const other = await harness.payments.accept({
      request: payment({ merchantId: 'mer_beta', reference: 'ORDER-SHARED' }),
      organizationId: 'org_b',
      actorId: 'usr_cashier_b',
      correlationId: 'cor_b',
    });

    expect(other.replayed).toBe(false);
  });
});

// --- ledger tampering --------------------------------------------------------

describe('ledger integrity', () => {
  it('offers no way to update a posted journal', async () => {
    /*
     * There is no `update` on the ledger and there will not be one. A correction is a reversal or
     * an adjustment, both of which post a new journal and leave the original standing.
     */
    const harness = await pilot();

    expect((harness.ledger as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((harness.ledger as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it('refuses an unbalanced journal', async () => {
    const harness = await pilot();
    await approved(harness);
    const wallet = await harness.walletOf('org_a', 'mer_alpha');
    const walletRecord = await harness.wallets.get(wallet?.id as string, 'org_a');

    await expect(
      harness.ledger.post({
        organizationId: 'org_a',
        description: 'An unbalanced posting.',
        entries: [
          {
            accountId: harness.clearingAccountId,
            direction: 'debit',
            amount: { currency: PILOT_CURRENCY, amount: '10.00' },
            description: 'Debit.',
            dimension: null,
            metadata: {},
          },
          {
            accountId: walletRecord.accountId,
            direction: 'credit',
            amount: { currency: PILOT_CURRENCY, amount: '9.00' },
            description: 'Credit that does not balance it.',
            dimension: null,
            metadata: {},
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('posts no journal for a refused payment', async () => {
    /*
     * The invariant. A journal for a payment that did not happen is money the platform believes it
     * holds and cannot account for.
     */
    const harness = await pilot();
    await approved(harness);

    const before = (await harness.ledger.list({ organizationId: 'org_a', page: 1, pageSize: 100 }))
      .length;

    await harness.payments.accept({
      request: payment({ amount: '5000.00', reference: 'ORDER-OVER' }),
      organizationId: 'org_a',
      actorId: 'usr_cashier',
      correlationId: 'cor_over',
    });

    const after = (await harness.ledger.list({ organizationId: 'org_a', page: 1, pageSize: 100 }))
      .length;

    expect(after).toBe(before);
  });

  it('keeps the wallet balance equal to what the journals say', async () => {
    const harness = await pilot();
    await approved(harness);

    for (let index = 0; index < 5; index += 1) {
      await harness.payments.accept({
        request: payment({ amount: '100.00', reference: `ORDER-BAL-${index}` }),
        organizationId: 'org_a',
        actorId: 'usr_cashier',
        correlationId: `cor_bal_${index}`,
      });
    }

    const wallet = await harness.walletOf('org_a', 'mer_alpha');
    const balance = await harness.wallets.balance(wallet?.id as string, 'org_a');
    const totals = harness.payments.totals(PILOT_CURRENCY);

    // Five payments of 100.00, each netting 99.50 after the 0.50% fee.
    expect(balance.total.amount.units).toBe(totals.net.amount.units);
    expect(balance.total.amount.units).toBe(money('497.50', PILOT_CURRENCY).amount.units);
  });
});

// --- audit integrity ---------------------------------------------------------

describe('audit', () => {
  it('records every consequential action', async () => {
    const harness = await pilot();
    await approved(harness);

    await harness.payments.accept({
      request: payment({ reference: 'ORDER-AUDIT' }),
      organizationId: 'org_a',
      actorId: 'usr_cashier',
      correlationId: 'cor_audit',
    });

    const actions = harness.auditSink.records.map((record) => record.action);

    expect(actions).toContain('mwb.merchant.registered');
    expect(actions).toContain('mwb.merchant.verified');
    expect(actions).toContain('mwb.merchant.approved');
    expect(actions).toContain('mwb.payment.accepted');
  });

  it('carries the correlation id into the audit record', async () => {
    const harness = await pilot();
    await approved(harness);

    await harness.payments.accept({
      request: payment({ reference: 'ORDER-CORR' }),
      organizationId: 'org_a',
      actorId: 'usr_cashier',
      correlationId: 'cor_specific',
    });

    const record = harness.auditSink.records.find(
      (entry) => entry.action === 'mwb.payment.accepted',
    );

    expect((record?.metadata as Record<string, unknown>).correlationId).toBe('cor_specific');
  });

  it('scopes every record to its organization', async () => {
    // An audit record with no tenant is a record that appears in everybody's trail.
    const harness = await pilot();
    await approved(harness);

    const scoped = harness.auditSink.records.filter((record) => record.action.startsWith('mwb.'));

    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((record) => record.organizationId === 'org_a')).toBe(true);
  });

  it('offers no way to delete an audit record through the service', async () => {
    /*
     * Asserted on the service rather than the sink. `InMemoryAuditSink` has a `clear()` — it is a
     * test double, and a double that could not be reset would be a double every suite leaked
     * through. What matters is that the *service* has no delete, so no application code path
     * reaches one, and the persistent sink appends.
     */
    const harness = await pilot();
    const service = harness.audit as unknown as Record<string, unknown>;

    expect(service.delete).toBeUndefined();
    expect(service.clear).toBeUndefined();
    expect(service.update).toBeUndefined();
  });
});

// --- PII and sensitive export ------------------------------------------------

describe('sensitive data', () => {
  it('puts no amount or balance in a merchant record', () => {
    /*
     * The merchant record is `CONFIDENTIAL`; the wallet is `RESTRICTED`. Keeping a balance on the
     * merchant would raise the merchant record to the higher classification, and every read of it
     * would then carry the stricter obligations.
     */
    const record = merchant();

    expect(Object.keys(record)).not.toContain('balance');
    expect(Object.keys(record)).not.toContain('turnover');
  });

  it('does not put payment amounts in the merchant audit metadata', async () => {
    const harness = await pilot();
    await approved(harness);

    const record = harness.auditSink.records.find(
      (entry) => entry.action === 'mwb.merchant.approved',
    );

    expect(JSON.stringify(record?.metadata ?? {})).not.toContain('amount');
  });
});

// --- API key misuse ----------------------------------------------------------

describe('credential scope', () => {
  it('does not let a read scope satisfy a write requirement', () => {
    // From @trustsystem/api-keys, reused rather than restated: write covers read, and never the reverse.
    expect(scopeSatisfies(['payments:read'], 'payments:write')).toBe(false);
    expect(scopeSatisfies(['payments:write'], 'payments:read')).toBe(true);
  });

  it('does not let a scope on one resource reach another', () => {
    expect(scopeSatisfies(['payments:write'], 'merchants:write')).toBe(false);
  });
});

// --- what the pilot does not defend against ---------------------------------

describe('the boundary of these tests', () => {
  it('does not test transport security, which is the deployment’s', () => {
    /*
     * Stated rather than silently absent. TLS, certificate pinning, network policy and the
     * platform's own WAF are deployment concerns; a test here asserting them would be asserting
     * something this process cannot observe.
     */
    expect(ROLE_CAPABILITIES.auditor.writes).toBe(false);
  });
});
