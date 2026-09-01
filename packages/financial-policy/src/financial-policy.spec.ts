import { describe, expect, it } from 'vitest';
import { ApiError } from '@trustsystem/errors';
import { CurrencyRegistry, money } from '@trustsystem/financial-core';
import { FinancialPolicyEngine } from './policy';

const currencies = new CurrencyRegistry();
const usd = (amount: string) => money(amount, 'USD', currencies);

const engine = (policies: unknown[] = []) => new FinancialPolicyEngine(policies, currencies);

const organizationPolicy = (overrides: Record<string, unknown> = {}) => ({
  name: 'org-a',
  scope: { kind: 'organization', organizationId: 'org_a' },
  allowedCurrencies: ['USD'],
  ...overrides,
});

describe('resolution', () => {
  it('always has a platform policy, even when none was configured', () => {
    /*
     * Without one, a tenant with no policy falls through to "no policy" — and the only readings
     * of that are "allow everything" and "deny everything". The first is unsafe and the second
     * makes the platform unusable.
     */
    expect(engine().resolve({ organizationId: 'org_a' }).name).toBe('platform-default');
  });

  it('picks the most specific policy, whole', () => {
    // Never merged: a merge produces a policy nobody wrote.
    const policies = engine([
      { name: 'platform', scope: { kind: 'platform' }, allowedCurrencies: ['USD', 'KHR'] },
      organizationPolicy({ allowedCurrencies: ['USD'] }),
    ]);

    expect(policies.resolve({ organizationId: 'org_a' }).allowedCurrencies).toEqual(['USD']);
    expect(policies.resolve({ organizationId: 'org_b' }).allowedCurrencies).toEqual(['USD', 'KHR']);
  });

  it('lets an account-type policy override an organization one', () => {
    const policies = engine([
      organizationPolicy(),
      {
        name: 'system-accounts',
        scope: { kind: 'account_type', accountType: 'system' },
        allowedCurrencies: ['USD', 'KHR', 'EUR'],
        allowNegativeBalance: true,
      },
    ]);

    expect(
      policies.resolve({ organizationId: 'org_a', accountType: 'system' }).allowNegativeBalance,
    ).toBe(true);
  });

  it('ignores a disabled policy', () => {
    const policies = engine([organizationPolicy({ enabled: false })]);

    expect(policies.resolve({ organizationId: 'org_a' }).name).toBe('platform-default');
  });
});

describe('currency', () => {
  it('treats an empty list as none, not all', () => {
    /*
     * The opposite reading makes an unconfigured platform accept every currency, and the first
     * symptom is a balance in a currency nobody can settle.
     */
    const decision = engine().check({
      context: { organizationId: 'org_a' },
      amount: usd('100.00'),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons[0]).toMatch(/An empty list means none rather than all/);
  });

  it('refuses a currency the policy does not list', () => {
    const decision = engine([organizationPolicy()]).check({
      context: { organizationId: 'org_a' },
      amount: money('400000', 'KHR', currencies),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons[0]).toMatch(/does not permit KHR. Permitted: USD/);
  });

  it('allows a listed one', () => {
    expect(
      engine([organizationPolicy()]).check({
        context: { organizationId: 'org_a' },
        amount: usd('100.00'),
      }).allowed,
    ).toBe(true);
  });
});

describe('negative balances', () => {
  it('refuses one by default', () => {
    const decision = engine([organizationPolicy()]).check({
      context: { organizationId: 'org_a' },
      amount: usd('100.00'),
      resultingBalance: usd('-1.00'),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons[0]).toMatch(/does not permit a negative balance/);
  });

  it('allows one within an overdraft limit', () => {
    const policies = engine([
      organizationPolicy({ allowNegativeBalance: true, overdraftLimits: { USD: '500.00' } }),
    ]);

    expect(
      policies.check({
        context: { organizationId: 'org_a' },
        amount: usd('100.00'),
        resultingBalance: usd('-500.00'),
      }).allowed,
    ).toBe(true);

    const past = policies.check({
      context: { organizationId: 'org_a' },
      amount: usd('100.00'),
      resultingBalance: usd('-500.01'),
    });

    expect(past.allowed).toBe(false);
    expect(past.reasons[0]).toMatch(/past the 500.00 USD overdraft limit/);
  });
});

describe('thresholds', () => {
  it('flags a transaction that needs approval', () => {
    const decision = engine([organizationPolicy({ approvalThresholds: { USD: '1000.00' } })]).check(
      { context: { organizationId: 'org_a' }, amount: usd('1000.01') },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(true);
  });

  it('does not flag one at the threshold', () => {
    // Above, not at. A threshold that fires at the round number surprises everybody who set it.
    expect(
      engine([organizationPolicy({ approvalThresholds: { USD: '1000.00' } })]).check({
        context: { organizationId: 'org_a' },
        amount: usd('1000.00'),
      }).requiresApproval,
    ).toBe(false);
  });

  it('flags a high-value transaction separately from approval', () => {
    const decision = engine([
      organizationPolicy({
        approvalThresholds: { USD: '10000.00' },
        highValueThresholds: { USD: '1000.00' },
      }),
    ]).check({ context: { organizationId: 'org_a' }, amount: usd('5000.00') });

    expect(decision.highValue).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it('requires approval for a reversal by default', () => {
    /*
     * A reversal moves money back on one person's decision, and it is the one operation in the
     * phase that can be used to hide another.
     */
    const decision = engine([organizationPolicy()]).check({
      context: { organizationId: 'org_a' },
      amount: usd('10.00'),
      operation: 'reversal',
    });

    expect(decision.requiresApproval).toBe(true);
  });
});

describe('reporting the reasons', () => {
  it('returns every reason, not the first', () => {
    // An operator who fixes one thing only to hit the next stops trusting the message.
    const decision = engine([organizationPolicy({ allowedCurrencies: ['KHR'] })]).check({
      context: { organizationId: 'org_a' },
      amount: usd('100.00'),
      resultingBalance: usd('-50.00'),
    });

    expect(decision.reasons).toHaveLength(2);
  });

  it('always names the policy that decided', () => {
    expect(
      engine([organizationPolicy()]).check({
        context: { organizationId: 'org_a' },
        amount: usd('100.00'),
      }).policyName,
    ).toBe('org-a');
  });

  it('throws with every reason when asserted', () => {
    expect(() =>
      engine([organizationPolicy({ allowedCurrencies: ['KHR'] })]).assert({
        context: { organizationId: 'org_a' },
        amount: usd('100.00'),
      }),
    ).toThrow(ApiError);
  });
});

describe('configuration lookups', () => {
  it('names the fee schedule for a transaction type', () => {
    const policies = engine([
      organizationPolicy({ feeScheduleKeys: { payment: 'payment.standard' } }),
    ]);

    expect(policies.feeScheduleFor({ organizationId: 'org_a' }, 'payment')).toBe(
      'payment.standard',
    );
    expect(policies.feeScheduleFor({ organizationId: 'org_a' }, 'refund')).toBeNull();
  });

  it('names the settlement account for a currency', () => {
    const policies = engine([
      organizationPolicy({ settlementAccountCodes: { USD: 'settlement.bank.usd' } }),
    ]);

    expect(policies.settlementAccountFor({ organizationId: 'org_a' }, 'USD')).toBe(
      'settlement.bank.usd',
    );
  });
});

describe('registration', () => {
  it('names the policy in a validation failure', () => {
    expect(() => engine([{ name: 'broken', scope: { kind: 'nonsense' } }])).toThrow(ApiError);
  });
});
