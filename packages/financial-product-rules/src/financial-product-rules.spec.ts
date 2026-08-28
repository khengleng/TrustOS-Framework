import { describe, expect, it } from 'vitest';
import type { ProductExecutionContext, ProductRule } from '@trustos/financial-product-core';
import { productRuleSchema } from '@trustos/financial-product-core';
import {
  buildFacts,
  evaluateRules,
  explainDecision,
  formatRate,
  unknownFacts,
  validateRules,
} from './index';

function rule(overrides: Partial<ProductRule> & { id: string }): ProductRule {
  return productRuleSchema.parse({
    description: `Rule ${overrides.id}.`,
    priority: 10,
    when: { field: 'amountMinorUnits', operator: 'exists' },
    then: [{ kind: 'tag', tag: 'touched' }],
    ...overrides,
  });
}

function context(overrides: Partial<ProductExecutionContext> = {}): ProductExecutionContext {
  return {
    executionId: 'fpex_1',
    productId: 'merchant-wallet-basic',
    productVersion: '1.0.0',
    definitionHash: 'sha256:abc',
    variantId: null,
    actor: { actorId: 'usr_1', actorType: 'user', organizationId: 'org_a' },
    organizationId: 'org_a',
    idempotencyKey: 'idm_1',
    input: {
      amountMinorUnits: '250000',
      currency: 'USD',
      merchantTier: 'GOLD',
      references: {},
      attributes: {},
    },
    usage: { dailyUsageMinorUnits: '100000', monthlyUsageMinorUnits: '900000', velocityCount: 3 },
    risk: { score: 42, level: 'MEDIUM' },
    environment: 'production',
    startedAt: new Date('2026-06-01T09:30:00.000Z'),
    correlationId: 'cor_1',
    ...overrides,
  };
}

describe('the fact map', () => {
  it('exposes only declared facts, never the actor', () => {
    const facts = buildFacts(context()) as Record<string, unknown>;

    // The whole reason the engine receives a fact map rather than the context.
    expect(facts.actorId).toBeUndefined();
    expect(facts.organizationId).toBeUndefined();
    expect(facts.idempotencyKey).toBeUndefined();
    expect(facts.merchantTier).toBe('GOLD');
  });

  it('carries the amount twice: a string to quote and an integer to compare', () => {
    const facts = buildFacts(context());
    expect(facts.amount).toBe('250000');
    expect(facts.amountMinorUnits).toBe(250_000);
  });

  it('reads the clock once, at execution start', () => {
    const facts = buildFacts(context());
    expect(facts.hourOfDay).toBe(9);
    expect(facts.dayOfWeek).toBe(1);
  });

  it('clamps an amount beyond the safe integer range upward rather than to zero', () => {
    const facts = buildFacts(
      context({
        input: { amountMinorUnits: '99999999999999999999', references: {}, attributes: {} },
      }),
    );
    // An amount above every threshold is the honest answer for a threshold comparison.
    expect(facts.amountMinorUnits).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reports fields that are not facts', () => {
    expect(unknownFacts(['amountMinorUnits', 'merchantTeir'])).toEqual(['merchantTeir']);
  });
});

describe('evaluation', () => {
  it('is deterministic across repeated runs', () => {
    const rules = [
      rule({
        id: 'base-rate',
        priority: 20,
        then: [
          {
            kind: 'set_fee',
            feeCode: 'ACCEPTANCE',
            basis: 'percentage',
            rate: { hundredthsOfBasisPoint: '7500' },
          },
        ],
      }),
      rule({
        id: 'gold-rate',
        priority: 10,
        when: { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
        then: [
          {
            kind: 'set_fee',
            feeCode: 'ACCEPTANCE',
            basis: 'percentage',
            rate: { hundredthsOfBasisPoint: '5000' },
          },
        ],
      }),
    ];

    const facts = buildFacts(context());
    const first = evaluateRules(rules, facts);
    const second = evaluateRules([...rules].reverse(), facts);

    expect(first.fees.ACCEPTANCE).toEqual(second.fees.ACCEPTANCE);
    expect(first.fees.ACCEPTANCE?.rate?.hundredthsOfBasisPoint).toBe('5000');
  });

  it('records the superseded rule rather than discarding it', () => {
    const decision = evaluateRules(
      [
        rule({
          id: 'gold-rate',
          priority: 10,
          then: [
            {
              kind: 'set_fee',
              feeCode: 'ACCEPTANCE',
              basis: 'percentage',
              rate: { hundredthsOfBasisPoint: '5000' },
            },
          ],
        }),
        rule({
          id: 'base-rate',
          priority: 20,
          then: [
            {
              kind: 'set_fee',
              feeCode: 'ACCEPTANCE',
              basis: 'percentage',
              rate: { hundredthsOfBasisPoint: '7500' },
            },
          ],
        }),
      ],
      buildFacts(context()),
    );

    const base = decision.trace.find((entry) => entry.ruleId === 'base-rate');
    expect(base?.outcomes[0]?.applied).toBe(false);
    expect(explainDecision(decision).some((line) => line.includes('superseded'))).toBe(true);
  });

  it('accumulates reviews rather than letting a higher priority hide one', () => {
    const decision = evaluateRules(
      [
        rule({
          id: 'risk-review',
          priority: 5,
          then: [{ kind: 'require_review', level: 'RISK', reason: 'High value.' }],
        }),
        rule({
          id: 'compliance-review',
          priority: 6,
          then: [{ kind: 'require_review', level: 'COMPLIANCE', reason: 'Screening.' }],
        }),
      ],
      buildFacts(context()),
    );

    expect(decision.reviews.map((review) => review.level).sort()).toEqual(['COMPLIANCE', 'RISK']);
  });

  it('de-duplicates a review level demanded twice', () => {
    const decision = evaluateRules(
      [
        rule({
          id: 'a',
          priority: 5,
          then: [{ kind: 'require_review', level: 'RISK', reason: 'One.' }],
        }),
        rule({
          id: 'b',
          priority: 6,
          then: [{ kind: 'require_review', level: 'RISK', reason: 'Two.' }],
        }),
      ],
      buildFacts(context()),
    );

    expect(decision.reviews).toHaveLength(1);
  });

  it('stops at a denial and marks everything after it as not evaluated', () => {
    const decision = evaluateRules(
      [
        rule({
          id: 'refuse',
          priority: 1,
          then: [{ kind: 'deny', code: 'prohibited_country', reason: 'Not supported.' }],
        }),
        rule({
          id: 'charge',
          priority: 2,
          then: [
            {
              kind: 'set_fee',
              feeCode: 'ACCEPTANCE',
              basis: 'flat',
              flat: { minorUnits: '100', currency: 'USD' },
            },
          ],
        }),
      ],
      buildFacts(context()),
    );

    expect(decision.denied?.code).toBe('prohibited_country');
    // A decision listing a fee for a refused payment reads as "we charged them anyway".
    expect(decision.fees.ACCEPTANCE).toBeUndefined();
    expect(decision.trace.find((entry) => entry.ruleId === 'charge')?.skippedReason).toBe(
      'after_deny',
    );
  });

  it('skips a disabled rule and says so, rather than dropping it from the trace', () => {
    const decision = evaluateRules([rule({ id: 'off', enabled: false })], buildFacts(context()));
    expect(decision.trace[0]?.skippedReason).toBe('disabled');
  });

  it('records a non-matching rule and the condition that did not hold', () => {
    const decision = evaluateRules(
      [
        rule({
          id: 'silver-only',
          when: { field: 'merchantTier', operator: 'eq', value: 'SILVER' },
        }),
      ],
      buildFacts(context()),
    );

    expect(decision.trace[0]?.matched).toBe(false);
    expect(explainDecision(decision)[0]).toContain('no match');
  });

  it('produces an explanation from the same structure the runtime acted on', () => {
    const decision = evaluateRules(
      [
        rule({
          id: 'gold-rate',
          then: [
            {
              kind: 'set_fee',
              feeCode: 'ACCEPTANCE',
              basis: 'percentage',
              rate: { hundredthsOfBasisPoint: '5000' },
            },
          ],
        }),
      ],
      buildFacts(context()),
    );

    expect(explainDecision(decision)).toEqual(['gold-rate (p10): applied fee ACCEPTANCE = 0.5%.']);
  });
});

describe('rate formatting', () => {
  it('renders hundredths of a basis point without floating point', () => {
    expect(formatRate('5000')).toBe('0.5%');
    expect(formatRate('7500')).toBe('0.75%');
    expect(formatRate('1000000')).toBe('100%');
    expect(formatRate('1')).toBe('0.0001%');
    expect(formatRate(undefined)).toBe('unspecified');
  });
});

describe('validation', () => {
  it('refuses a rule reading a fact the runtime does not supply', () => {
    const result = validateRules([
      rule({ id: 'typo', when: { field: 'merchantTeir', operator: 'eq', value: 'GOLD' } }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe('unknown_fact');
  });

  it('refuses an ordering comparison against the string amount', () => {
    const result = validateRules([
      rule({ id: 'wrong-amount', when: { field: 'amount', operator: 'gt', value: 200_000 } }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe('ordering_on_string_fact');
    expect(result.findings[0]?.remediation).toContain('amountMinorUnits');
  });

  it('accepts the same comparison against the integer form', () => {
    const result = validateRules([
      rule({
        id: 'right-amount',
        when: { field: 'amountMinorUnits', operator: 'gt', value: 200_000 },
      }),
    ]);
    expect(result.valid).toBe(true);
  });

  it('refuses a route to a block the product does not contain', () => {
    const result = validateRules(
      [rule({ id: 'route-away', then: [{ kind: 'route', toBlock: 'nowhere' }] })],
      { blockKeys: ['create-wallet', 'accept-payment'] },
    );
    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe('unknown_route_target');
  });

  it('warns about a rule shadowed by a catch-all at a lower priority', () => {
    const result = validateRules([
      rule({
        id: 'base-rate',
        priority: 5,
        when: { field: 'amountMinorUnits', operator: 'exists' },
        then: [
          {
            kind: 'set_fee',
            feeCode: 'ACCEPTANCE',
            basis: 'flat',
            flat: { minorUnits: '100', currency: 'USD' },
          },
        ],
      }),
      rule({
        id: 'gold-rate',
        priority: 10,
        when: { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
        then: [
          {
            kind: 'set_fee',
            feeCode: 'ACCEPTANCE',
            basis: 'flat',
            flat: { minorUnits: '50', currency: 'USD' },
          },
        ],
      }),
    ]);

    const shadowed = result.findings.find((finding) => finding.code === 'shadowed_rule');
    expect(shadowed?.ruleId).toBe('gold-rate');
    // A warning rather than an error: occasionally the override is deliberate.
    expect(result.valid).toBe(true);
  });

  it('warns when two rules at the same priority write the same slot', () => {
    const result = validateRules([
      rule({
        id: 'a-rate',
        priority: 10,
        when: { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
        then: [
          {
            kind: 'set_fee',
            feeCode: 'ACCEPTANCE',
            basis: 'flat',
            flat: { minorUnits: '100', currency: 'USD' },
          },
        ],
      }),
      rule({
        id: 'b-rate',
        priority: 10,
        when: { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
        then: [
          {
            kind: 'set_fee',
            feeCode: 'ACCEPTANCE',
            basis: 'flat',
            flat: { minorUnits: '50', currency: 'USD' },
          },
        ],
      }),
    ]);

    expect(result.findings.some((finding) => finding.code === 'ambiguous_priority')).toBe(true);
  });

  it('refuses a rule unreachable behind a catch-all denial', () => {
    const result = validateRules([
      rule({
        id: 'refuse-all',
        priority: 1,
        when: { field: 'amountMinorUnits', operator: 'exists' },
        then: [{ kind: 'deny', code: 'closed', reason: 'Product closed.' }],
      }),
      rule({ id: 'charge', priority: 2 }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.findings.some((finding) => finding.code === 'unreachable_after_deny')).toBe(true);
  });

  it('refuses a condition that cannot match', () => {
    const result = validateRules([
      rule({
        id: 'impossible',
        when: {
          all: [
            { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
            { field: 'merchantTier', operator: 'eq', value: 'SILVER' },
          ],
        },
      }),
    ]);

    expect(result.valid).toBe(false);
    expect(result.findings[0]?.code).toBe('contradictory_condition');
  });

  it('accepts a well-formed rule set with no findings', () => {
    const result = validateRules(
      [
        rule({
          id: 'gold-rate',
          priority: 10,
          when: { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
          then: [
            {
              kind: 'set_fee',
              feeCode: 'ACCEPTANCE',
              basis: 'percentage',
              rate: { hundredthsOfBasisPoint: '5000' },
            },
          ],
        }),
        rule({
          id: 'enhanced-review',
          priority: 20,
          when: { field: 'amountMinorUnits', operator: 'gt', value: 200_000 },
          then: [{ kind: 'require_review', level: 'COMPLIANCE', reason: 'Above threshold.' }],
        }),
      ],
      { feeCodes: ['ACCEPTANCE'] },
    );

    expect(result.findings).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
