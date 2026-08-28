import { describe, expect, it } from 'vitest';
import { PolicyRegistry, assertSufficientPolicyBump, policyDocumentSchema } from './index';

function policy(overrides: Record<string, unknown> = {}) {
  return policyDocumentSchema.parse({
    policyId: 'security.mfa-threshold',
    name: 'MFA above a threshold',
    description: 'Requires a second factor for transactions above the configured amount.',
    category: 'security',
    version: '1.0.0',
    owner: 'usr_security',
    status: 'active',
    rules: [
      {
        ruleId: 'require-mfa-above-threshold',
        description: 'Above the threshold, a second factor is required.',
        priority: 10,
        when: { field: 'amountMinorUnits', operator: 'gt', value: 100_000 },
        effect: 'deny',
        reason: 'A transaction above 1,000 requires a second factor.',
      },
      {
        ruleId: 'allow-below-threshold',
        description: 'Below the threshold, no second factor is needed.',
        priority: 20,
        when: { field: 'amountMinorUnits', operator: 'lte', value: 100_000 },
        effect: 'allow',
        reason: 'Below the threshold.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      { name: 'above the threshold', attributes: { amountMinorUnits: 200_000 }, expect: 'deny' },
      { name: 'below the threshold', attributes: { amountMinorUnits: 5_000 }, expect: 'allow' },
    ],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  });
}

describe('policy documents', () => {
  it('refuses a default effect other than deny', () => {
    // A policy whose default is allow permits everything it did not think of, and those are
    // exactly the interesting cases.
    expect(() => policy({ defaultEffect: 'allow' })).toThrow();
  });

  it('refuses a denial carrying obligations', () => {
    expect(() =>
      policy({
        rules: [
          {
            ruleId: 'contradiction',
            description: 'Denies and obliges.',
            priority: 1,
            when: { field: 'x', operator: 'exists' },
            effect: 'deny',
            obligations: [{ kind: 'watermark', description: 'Watermark the file.' }],
            reason: 'No.',
          },
        ],
      }),
    ).toThrow(/nothing to oblige/);
  });

  it('requires a test case for every outcome it can produce', () => {
    // A policy that denies everything passes any set of deny-only tests.
    expect(() =>
      policy({
        testCases: [{ name: 'above', attributes: { amountMinorUnits: 200_000 }, expect: 'deny' }],
      }),
    ).toThrow(/no test case expects an allow/);
  });

  it('requires at least one denying test', () => {
    expect(() =>
      policy({
        rules: [
          {
            ruleId: 'allow-all',
            description: 'Allows.',
            priority: 1,
            when: { field: 'x', operator: 'exists' },
            effect: 'allow',
            reason: 'Fine.',
          },
        ],
        testCases: [{ name: 'anything', attributes: { x: 1 }, expect: 'allow' }],
      }),
    ).toThrow(/not been tested against its own default/);
  });

  it('refuses duplicate rule ids', () => {
    const rule = {
      ruleId: 'same',
      description: 'A rule.',
      priority: 1,
      when: { field: 'x', operator: 'exists' },
      effect: 'deny',
      reason: 'Because.',
    };

    expect(() => policy({ rules: [rule, { ...rule, priority: 2 }] })).toThrow(/share the id/);
  });

  it('refuses a deprecated policy with no successor', () => {
    expect(() => policy({ status: 'deprecated' })).toThrow(/names its successor/);
  });
});

describe('the registry', () => {
  it('refuses re-publishing an existing version', () => {
    // A decision recorded against version 3 must be reproducible from version 3 forever.
    const registry = new PolicyRegistry([policy()]);
    expect(() => registry.publish(policy({ name: 'Changed' }))).toThrow(/never changes/);
  });

  it('refuses a version that goes backwards', () => {
    const registry = new PolicyRegistry([policy({ version: '2.0.0' })]);
    expect(() => registry.publish(policy({ version: '1.5.0' }))).toThrow(/not newer/);
  });

  it('resolves the newest active version, not the newest', () => {
    // Publishing is not activation. Conflating them is how an unreviewed policy takes effect.
    const registry = new PolicyRegistry([
      policy({ version: '1.0.0', status: 'active' }),
      policy({ version: '2.0.0', status: 'draft' }),
    ]);

    expect(registry.find('security.mfa-threshold')?.version).toBe('1.0.0');
  });

  it('finds a specific version whatever its status', () => {
    const registry = new PolicyRegistry([
      policy({ version: '1.0.0', status: 'active' }),
      policy({ version: '2.0.0', status: 'draft' }),
    ]);

    expect(registry.find('security.mfa-threshold', '2.0.0')?.status).toBe('draft');
  });

  it('explains why a policy has no active version', () => {
    const registry = new PolicyRegistry([policy({ status: 'draft' })]);
    expect(() => registry.require('security.mfa-threshold')).toThrow(/1\.0\.0 \(draft\)/);
  });

  it('lists active policies by category', () => {
    const registry = new PolicyRegistry([policy()]);
    expect(registry.byCategory('security')).toHaveLength(1);
    expect(registry.byCategory('financial')).toHaveLength(0);
  });

  it('reports overdue reviews', () => {
    const registry = new PolicyRegistry([policy()]);
    expect(registry.overdueReviews(new Date('2027-06-01'))).toHaveLength(1);
    expect(registry.overdueReviews(new Date('2026-06-01'))).toHaveLength(0);
  });
});

describe('version bumps', () => {
  it('refuses a loosening on a minor bump', () => {
    // A version number alone should tell a reviewer whether a policy became more permissive.
    const previous = policy({ version: '1.0.0' });
    const next = policy({
      version: '1.1.0',
      rules: [
        {
          ruleId: 'require-mfa-above-threshold',
          description: 'Above the threshold, a second factor is no longer required.',
          priority: 10,
          when: { field: 'amountMinorUnits', operator: 'gt', value: 100_000 },
          effect: 'allow',
          reason: 'The threshold no longer requires a second factor.',
        },
        {
          ruleId: 'allow-below-threshold',
          description: 'Below the threshold, no second factor is needed.',
          priority: 20,
          when: { field: 'amountMinorUnits', operator: 'lte', value: 100_000 },
          effect: 'allow',
          reason: 'Below the threshold.',
        },
      ],
      testCases: [
        { name: 'above', attributes: { amountMinorUnits: 200_000 }, expect: 'allow' },
        { name: 'missing attribute falls through to the default', attributes: {}, expect: 'deny' },
      ],
    });

    expect(() => assertSufficientPolicyBump(previous, next)).toThrow(/loosening/);
  });

  it('permits a loosening on a major bump', () => {
    const previous = policy({ version: '1.0.0' });
    const next = policy({
      version: '2.0.0',
      rules: [previous.rules[1]!],
      testCases: [
        { name: 'below', attributes: { amountMinorUnits: 5_000 }, expect: 'allow' },
        { name: 'nothing supplied', attributes: {}, expect: 'deny' },
      ],
    });

    expect(() => assertSufficientPolicyBump(previous, next)).not.toThrow();
  });

  it('permits a tightening on a minor bump', () => {
    const previous = policy({ version: '1.0.0' });
    const next = policy({ version: '1.1.0' });
    expect(() => assertSufficientPolicyBump(previous, next)).not.toThrow();
  });
});
