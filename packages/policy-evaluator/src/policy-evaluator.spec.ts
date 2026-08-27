import { describe, expect, it } from 'vitest';
import { policyDocumentSchema } from '@trustos/policy-registry';
import {
  analysePolicy,
  assertObligationsUnderstood,
  evaluatePolicy,
  explainDecision,
  runPolicyTests,
} from './index';

function policy(overrides: Record<string, unknown> = {}) {
  return policyDocumentSchema.parse({
    policyId: 'data.export-approval',
    name: 'Export approval',
    description: 'Decides whether an export may proceed and what it must carry.',
    category: 'data',
    version: '2.1.0',
    owner: 'usr_compliance',
    status: 'active',
    rules: [
      {
        ruleId: 'deny-highly-restricted',
        description: 'Highly restricted data is never exported.',
        priority: 10,
        when: { field: 'classification', operator: 'eq', value: 'HIGHLY_RESTRICTED' },
        effect: 'deny',
        reason: 'Highly restricted data does not leave the system.',
      },
      {
        ruleId: 'allow-with-watermark',
        description: 'Restricted exports are watermarked and expire.',
        priority: 20,
        when: { field: 'classification', operator: 'eq', value: 'RESTRICTED' },
        effect: 'allow',
        obligations: [
          {
            kind: 'watermark',
            parameters: { includeActor: true },
            description: 'Watermark with the actor and instant.',
          },
          {
            kind: 'expire_after_hours',
            parameters: { hours: 8 },
            description: 'The link expires in eight hours.',
          },
        ],
        reason: 'Restricted exports are permitted with a watermark and an expiry.',
      },
      {
        ruleId: 'allow-internal',
        description: 'Internal data exports freely.',
        priority: 30,
        when: { field: 'classification', operator: 'eq', value: 'INTERNAL' },
        effect: 'allow',
        reason: 'Internal data may be exported.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      {
        name: 'highly restricted',
        attributes: { classification: 'HIGHLY_RESTRICTED' },
        expect: 'deny',
      },
      {
        name: 'restricted',
        attributes: { classification: 'RESTRICTED' },
        expect: 'allow',
        expectedRuleId: 'allow-with-watermark',
      },
      { name: 'internal', attributes: { classification: 'INTERNAL' }, expect: 'allow' },
      {
        name: 'unknown classification falls through',
        attributes: { classification: 'SOMETHING' },
        expect: 'deny',
      },
    ],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  });
}

describe('evaluation', () => {
  it('takes the first match by priority', () => {
    const decision = evaluatePolicy(policy(), { classification: 'RESTRICTED' });

    expect(decision.decision).toBe('ALLOW');
    expect(decision.ruleId).toBe('allow-with-watermark');
  });

  it('denies when nothing matches, and says the default decided', () => {
    // A policy that matched nothing has decided, and it has decided no.
    const decision = evaluatePolicy(policy(), { classification: 'SOMETHING_NEW' });

    expect(decision.decision).toBe('DENY');
    expect(decision.ruleId).toBeNull();
    expect(decision.reasons[0]).toContain('has decided no');
  });

  it('is deterministic whatever order the rules arrive in', () => {
    const forward = policy();
    const reversed = policy({ rules: [...forward.rules].reverse() });

    expect(evaluatePolicy(reversed, { classification: 'RESTRICTED' }).ruleId).toBe(
      evaluatePolicy(forward, { classification: 'RESTRICTED' }).ruleId,
    );
  });

  it('reports attributes the policy reads and nobody supplied', () => {
    // A rule reading a missing attribute never fires, so a caller who forgets one gets a policy
    // that has silently stopped enforcing part of itself.
    const decision = evaluatePolicy(policy(), {});

    expect(decision.missingAttributes).toEqual(['classification']);
    expect(decision.decision).toBe('DENY');
  });

  it('records every rule considered, and marks the ones it skipped', () => {
    const decision = evaluatePolicy(policy(), { classification: 'HIGHLY_RESTRICTED' });

    expect(decision.trace).toHaveLength(3);
    expect(decision.trace[0]?.matched).toBe(true);
    expect(decision.trace[1]?.skipped).toBe(true);
    expect(decision.trace[2]?.skipped).toBe(true);
  });

  it('carries obligations on an allow', () => {
    const decision = evaluatePolicy(policy(), { classification: 'RESTRICTED' });
    expect(decision.obligations.map((obligation) => obligation.kind)).toEqual([
      'watermark',
      'expire_after_hours',
    ]);
  });
});

describe('obligations', () => {
  const decision = evaluatePolicy(policy(), { classification: 'RESTRICTED' });

  it('refuses a decision carrying an obligation the caller cannot honour', () => {
    // A caller ignoring an unknown obligation converts a conditional permission into an
    // unconditional one.
    expect(() => assertObligationsUnderstood(decision, ['watermark'])).toThrow(
      /turns a conditional permission into an unconditional one/,
    );
  });

  it('permits when every obligation is understood', () => {
    expect(() =>
      assertObligationsUnderstood(decision, ['watermark', 'expire_after_hours']),
    ).not.toThrow();
  });

  it('ignores obligations on a denial, because nothing is happening', () => {
    const denied = evaluatePolicy(policy(), { classification: 'HIGHLY_RESTRICTED' });
    expect(() => assertObligationsUnderstood(denied, [])).not.toThrow();
  });
});

describe('the explanation', () => {
  it('names the policy version, the rule and the reason', () => {
    const lines = explainDecision(evaluatePolicy(policy(), { classification: 'RESTRICTED' }));

    expect(lines[0]).toContain('data.export-approval@2.1.0');
    expect(lines[0]).toContain('allow-with-watermark');
    expect(lines.join('\n')).toContain('watermark');
  });

  it('says which attributes were missing', () => {
    const lines = explainDecision(evaluatePolicy(policy(), {}));
    expect(lines.join('\n')).toContain('those rules did not run');
  });
});

describe('a policy’s own tests', () => {
  it('passes when the policy does what it says', () => {
    expect(runPolicyTests(policy()).passed).toBe(true);
  });

  it('fails when a rule id is not the expected one', () => {
    const shifted = policy({
      testCases: [
        {
          name: 'restricted',
          attributes: { classification: 'RESTRICTED' },
          expect: 'allow',
          expectedRuleId: 'allow-internal',
        },
        { name: 'deny', attributes: {}, expect: 'deny' },
      ],
    });

    expect(runPolicyTests(shifted).passed).toBe(false);
  });
});

describe('static analysis', () => {
  it('finds nothing wrong with a well-formed policy', () => {
    expect(analysePolicy(policy())).toEqual([]);
  });

  it('finds a rule made unreachable by a catch-all above it', () => {
    const withCatchAll = policy({
      rules: [
        {
          ruleId: 'catch-all',
          description: 'Denies anything with a classification.',
          priority: 1,
          when: { field: 'classification', operator: 'exists' },
          effect: 'deny',
          reason: 'Everything is refused.',
        },
        ...policy().rules,
      ],
      testCases: [
        { name: 'anything', attributes: { classification: 'INTERNAL' }, expect: 'deny' },
        { name: 'nothing', attributes: {}, expect: 'deny' },
        /*
         * An allow the catch-all makes unreachable.
         *
         * The schema requires an allow test because the policy *declares* allow rules; the
         * analysis then reports both the unreachable rules and this test failing. That pairing
         * is the point — a policy whose allow rules are dead fails its own tests, which is how
         * somebody notices before activating it.
         */
        {
          name: 'restricted, which the catch-all has made unreachable',
          attributes: { classification: 'RESTRICTED' },
          expect: 'allow',
        },
      ],
    });

    const findings = analysePolicy(withCatchAll);
    expect(findings.filter((finding) => finding.code === 'unreachable').length).toBe(3);
    expect(findings.some((finding) => finding.code === 'test_failure')).toBe(true);
  });

  it('warns about two rules at one priority with different effects', () => {
    const ambiguous = policy({
      rules: [
        { ...policy().rules[0]!, priority: 10 },
        { ...policy().rules[1]!, priority: 10 },
        policy().rules[2]!,
      ],
    });

    expect(analysePolicy(ambiguous).some((finding) => finding.code === 'ambiguous_priority')).toBe(
      true,
    );
  });

  it('warns about a policy that only denies', () => {
    // Either the policy is redundant or a condition is inverted, and the second is far more
    // common.
    const denyOnly = policy({
      rules: [policy().rules[0]!],
      testCases: [
        {
          name: 'highly restricted',
          attributes: { classification: 'HIGHLY_RESTRICTED' },
          expect: 'deny',
        },
      ],
    });

    expect(analysePolicy(denyOnly).some((finding) => finding.code === 'no_effect')).toBe(true);
  });

  it('reports a failing test case as an error', () => {
    const broken = policy({
      testCases: [
        { name: 'wrong expectation', attributes: { classification: 'RESTRICTED' }, expect: 'deny' },
        { name: 'right one', attributes: { classification: 'INTERNAL' }, expect: 'allow' },
      ],
    });

    const findings = analysePolicy(broken);
    expect(findings.some((finding) => finding.code === 'test_failure')).toBe(true);
  });
});
