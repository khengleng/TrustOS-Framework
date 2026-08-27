import { describe, expect, it } from 'vitest';
import { authorize, type AuthorizationRequest } from '@trustos/authorization';
import { PolicyRegistry, policyDocumentSchema } from '@trustos/policy-registry';
import { InMemoryPolicyDecisionSink, PolicyDecisionLog } from '@trustos/policy-decision-log';
import { PolicyEngine, asAuthorizationPolicy, evaluatePolicy } from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function policy(overrides: Record<string, unknown> = {}) {
  return policyDocumentSchema.parse({
    policyId: 'api.quota',
    name: 'API quota',
    description: 'Decides whether a consumer may make another call today.',
    category: 'api',
    version: '1.0.0',
    owner: 'usr_platform',
    status: 'active',
    rules: [
      {
        ruleId: 'deny-over-quota',
        description: 'Over the daily quota, calls are refused.',
        priority: 10,
        when: { field: 'callsToday', operator: 'gt', value: 10_000 },
        effect: 'deny',
        reason: 'The daily quota for this plan has been reached.',
      },
      {
        ruleId: 'allow-within-quota',
        description: 'Within the quota, calls proceed.',
        priority: 20,
        when: { field: 'callsToday', operator: 'lte', value: 10_000 },
        effect: 'allow',
        obligations: [
          { kind: 'emit_usage', parameters: {}, description: 'Record the call against the quota.' },
        ],
        reason: 'Within the daily quota.',
      },
    ],
    defaultEffect: 'deny',
    testCases: [
      { name: 'over', attributes: { callsToday: 20_000 }, expect: 'deny' },
      { name: 'within', attributes: { callsToday: 5 }, expect: 'allow' },
    ],
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-31T00:00:00.000Z',
    ...overrides,
  });
}

function engine(policies = [policy()], supportedObligations = ['emit_usage']) {
  const sink = new InMemoryPolicyDecisionSink();
  let counter = 0;

  return {
    sink,
    engine: new PolicyEngine({
      registry: new PolicyRegistry(policies),
      log: new PolicyDecisionLog(sink),
      supportedObligations,
      newDecisionId: () => `dec_${(counter += 1)}`,
      now: () => NOW,
    }),
  };
}

function decideInput(overrides: Record<string, unknown> = {}) {
  return {
    policyId: 'api.quota',
    attributes: { callsToday: 5 },
    actorId: 'usr_consumer',
    organizationId: 'org_a',
    action: 'api.call',
    correlationId: 'cor_1',
    ...overrides,
  };
}

describe('deciding', () => {
  it('decides and records', async () => {
    const { engine: policyEngine, sink } = engine();
    const decision = await policyEngine.decide(decideInput());

    expect(decision.decision).toBe('ALLOW');
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.policyVersion).toBe('1.0.0');
  });

  it('records a denial too', async () => {
    const { engine: policyEngine, sink } = engine();
    await policyEngine.decide(decideInput({ attributes: { callsToday: 20_000 } }));

    expect(sink.records[0]?.decision).toBe('DENY');
  });

  it('refuses a decision carrying an obligation the deployment cannot honour', async () => {
    const { engine: policyEngine } = engine([policy()], []);
    await expect(policyEngine.decide(decideInput())).rejects.toThrow(/cannot honour/);
  });

  it('refuses to enforce a policy that is not active', async () => {
    // A draft policy that could decide would take effect the moment somebody wrote it.
    const { engine: policyEngine } = engine([policy({ status: 'draft' })]);

    await expect(policyEngine.decide(decideInput({ policyVersion: '1.0.0' }))).rejects.toThrow(
      /cannot decide/,
    );
  });

  it('throws on a denial through assert, carrying the decision id', async () => {
    const { engine: policyEngine } = engine();

    try {
      await policyEngine.assert(decideInput({ attributes: { callsToday: 20_000 } }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { context?: Record<string, unknown> }).context?.decisionId).toBe('dec_1');
    }
  });

  it('measures how long the decision took', async () => {
    // A policy that got slow is a policy somebody will start skipping.
    const { engine: policyEngine, sink } = engine();
    await policyEngine.decide(decideInput());

    expect(sink.records[0]?.durationMicros).toBeGreaterThanOrEqual(0);
  });
});

describe('simulation', () => {
  it('evaluates a draft, which decide refuses', async () => {
    // Simulating an unapproved policy is the entire point of simulating.
    const { engine: policyEngine } = engine([policy({ status: 'draft' })]);

    const result = policyEngine.simulate({ policyId: 'api.quota', attributes: { callsToday: 5 } });
    expect(result.decision.decision).toBe('ALLOW');
  });

  it('records nothing', async () => {
    const { engine: policyEngine, sink } = engine();
    policyEngine.simulate({ policyId: 'api.quota', attributes: { callsToday: 5 } });

    expect(sink.records).toHaveLength(0);
  });

  it('returns an explanation a person reads', () => {
    const { engine: policyEngine } = engine();
    const result = policyEngine.simulate({
      policyId: 'api.quota',
      attributes: { callsToday: 20_000 },
    });

    expect(result.explanation[0]).toContain('DENY');
    expect(result.explanation.join('\n')).toContain('deny-over-quota');
  });
});

describe('validation before activation', () => {
  it('passes a policy that does what it says', () => {
    const { engine: policyEngine } = engine();
    expect(policyEngine.validate(policy()).valid).toBe(true);
  });

  it('fails a policy whose own tests do not pass', () => {
    const { engine: policyEngine } = engine();

    /*
     * The schema still demands an allow test, because the policy declares an allow rule. What is
     * broken is the *expectation*: this one says a call within the quota is refused.
     */
    const broken = policy({
      testCases: [
        {
          name: 'a call within the quota, expected to be refused',
          attributes: { callsToday: 5 },
          expect: 'deny',
        },
        {
          name: 'a call over the quota, expected to be permitted',
          attributes: { callsToday: 20_000 },
          expect: 'allow',
        },
      ],
    });

    expect(policyEngine.validate(broken).valid).toBe(false);
  });
});

describe('composing with the authorization engine', () => {
  const request = {
    actor: { userId: 'usr_consumer' },
    action: 'api.call',
  } as unknown as AuthorizationRequest;

  it('refuses through the adapter when the document policy denies', () => {
    const denied = evaluatePolicy(policy(), { callsToday: 20_000 });

    const decision = authorize(request, {
      policies: [asAuthorizationPolicy({ policyId: 'api.quota', decisionFor: () => denied })],
    });

    expect(decision.allow).toBe(false);
    expect(decision.policyId).toBe('policy-engine.api.quota');
  });

  it('abstains rather than allowing when the document policy allows', () => {
    /*
     * The property that keeps configuration from widening access.
     *
     * A document policy that could grant would let somebody edit configuration past a code
     * policy that refused, and the default-deny structure would then depend on nobody writing
     * an over-broad document.
     */
    const allowed = evaluatePolicy(policy(), { callsToday: 5 });

    const decision = authorize(request, {
      policies: [asAuthorizationPolicy({ policyId: 'api.quota', decisionFor: () => allowed })],
    });

    expect(decision.allow).toBe(false);
    expect(decision.policyId).toBeNull();
  });

  it('does not apply when there is no decision for the request', () => {
    const adapter = asAuthorizationPolicy({ policyId: 'api.quota', decisionFor: () => null });
    expect(adapter.appliesTo(request)).toBe(false);
  });
});
