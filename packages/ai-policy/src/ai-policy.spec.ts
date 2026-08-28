import { describe, expect, it } from 'vitest';
import { AiPolicyEngine } from './policy';

const engine = (policies: unknown[] = []) => new AiPolicyEngine(policies);

const context = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'org_1' as string | null,
  ...overrides,
});

describe('the platform default', () => {
  it('always exists, so a tenant with no policy is not an undefined case', () => {
    // "No policy" reads as either allow-everything or deny-everything; the first is unsafe and
    // the second makes the platform unusable.
    expect(engine().resolve(context()).name).toBe('platform-default');
  });

  it('allows any registered model', () => {
    expect(engine().check({ context: context(), modelId: 'anything' }).allowed).toBe(true);
  });

  it('denies tools, because an empty allow-list means none', () => {
    const result = engine().check({ context: context(), toolNames: ['delete_account'] });

    expect(result.allowed).toBe(false);
    expect(result.decisions[0]?.reason).toMatch(/denied by default/);
  });
});

describe('resolution', () => {
  const policies = [
    { name: 'platform', scope: { kind: 'platform' } },
    { name: 'tenant', scope: { kind: 'organization', organizationId: 'org_1' } },
    { name: 'agent-any', scope: { kind: 'agent', agentId: 'writer' } },
    { name: 'agent-tenant', scope: { kind: 'agent', agentId: 'writer', organizationId: 'org_1' } },
  ];

  it('prefers the most specific policy', () => {
    const target = engine(policies);

    expect(target.resolve(context({ agentId: 'writer' })).name).toBe('agent-tenant');
    expect(target.resolve(context({ organizationId: 'org_2', agentId: 'writer' })).name).toBe(
      'agent-any',
    );
    expect(target.resolve(context()).name).toBe('tenant');
    expect(target.resolve(context({ organizationId: 'org_9' })).name).toBe('platform');
  });

  it('never merges two policies', () => {
    // Merging produces a policy nobody wrote, and "why was this allowed" stops having an answer.
    const target = engine([
      {
        name: 'tenant',
        scope: { kind: 'organization', organizationId: 'org_1' },
        allowedTools: ['search'],
      },
      {
        name: 'agent',
        scope: { kind: 'agent', agentId: 'writer', organizationId: 'org_1' },
        allowedTools: ['write'],
      },
    ]);

    const result = target.check({ context: context({ agentId: 'writer' }), toolNames: ['search'] });

    expect(result.allowed).toBe(false);
    expect(result.policy.name).toBe('agent');
  });
});

describe('model and provider rules', () => {
  it('denies a model outside an allow-list, naming what is allowed', () => {
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        allowedModels: ['a', 'b'],
      },
    ]);

    const result = target.check({ context: context(), modelId: 'c' });

    expect(result.allowed).toBe(false);
    expect(result.decisions[0]?.reason).toMatch(/Allowed: a, b/);
  });

  it('lets a deny-list override an allow-list', () => {
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        allowedModels: ['a', 'b'],
        deniedModels: ['b'],
      },
    ]);

    expect(target.check({ context: context(), modelId: 'b' }).allowed).toBe(false);
  });

  it('denies a provider for data residency, and says so', () => {
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        allowedProviders: ['local'],
      },
    ]);

    expect(target.check({ context: context(), provider: 'remote' }).decisions[0]?.reason).toMatch(
      /data-residency requirement/,
    );
  });
});

describe('budgets and limits', () => {
  it('denies a request over the per-request ceiling', () => {
    // A single runaway request is the most common cost incident.
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        budget: { maxCostCentsPerRequest: 50 },
      },
    ]);

    const result = target.check({ context: context(), estimatedCostCents: 120 });

    expect(result.allowed).toBe(false);
    expect(result.decisions[0]?.reason).toMatch(/most common cost incident/);
  });

  it('denies more output tokens than the policy allows', () => {
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        maxOutputTokens: 1000,
      },
    ]);

    expect(target.check({ context: context(), requestedOutputTokens: 4000 }).allowed).toBe(false);
  });

  it('warns at 80% by default, which is late enough not to be noise', () => {
    expect(engine().resolve(context()).budget.warnAtFraction).toBe(0.8);
  });
});

describe('reporting violations', () => {
  it('returns every violation rather than the first', () => {
    // A caller fixing one only to hit the next makes four round trips to learn one thing.
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        allowedModels: ['a'],
        allowedTools: [],
      },
    ]);

    const result = target.check({
      context: context(),
      modelId: 'z',
      toolNames: ['t1', 't2'],
    });

    expect(result.decisions).toHaveLength(3);
  });

  it('names the deciding policy on every decision', () => {
    // "Denied" with no reason is an unfixable support ticket.
    const target = engine([
      {
        name: 'strict',
        scope: { kind: 'organization', organizationId: 'org_1' },
        allowedModels: ['a'],
      },
    ]);

    expect(target.check({ context: context(), modelId: 'z' }).decisions[0]?.policyName).toBe(
      'strict',
    );
  });

  it('throws the first violation from assert', () => {
    const target = engine();

    expect(() => target.assert({ context: context(), toolNames: ['danger'] })).toThrow(
      /not permitted by this policy/,
    );
  });
});

describe('human review', () => {
  it('requires review for a configured category', () => {
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        reviewRequiredCategories: ['medical_advice'],
      },
    ]);

    const result = target.requiresReview(context(), ['medical_advice', 'profanity']);

    expect(result.required).toBe(true);
    expect(result.reason).toMatch(/medical_advice/);
  });

  it('requires review for everything when a policy says so', () => {
    const target = engine([
      {
        name: 'p',
        scope: { kind: 'organization', organizationId: 'org_1' },
        reviewAllOutput: true,
      },
    ]);

    expect(target.requiresReview(context(), []).required).toBe(true);
  });

  it('does not require review by default', () => {
    expect(engine().requiresReview(context(), ['profanity']).required).toBe(false);
  });
});

describe('caching', () => {
  it('is off by default, because a careless cache key crosses tenants', () => {
    expect(engine().resolve(context()).allowCaching).toBe(false);
  });
});

describe('configuration errors', () => {
  it('names the policy and field', () => {
    expect(() => engine([{ name: 'broken', scope: { kind: 'nonsense' } }])).toThrow(
      /"broken" is not configured correctly/,
    );
  });
});

describe('describe', () => {
  it('orders most-specific first and says tools are denied by default', () => {
    const target = engine([
      { name: 'tenant', scope: { kind: 'organization', organizationId: 'org_1' } },
    ]);

    const described = target.describe();

    expect(described[0]?.name).toBe('tenant');
    expect(described[0]?.tools).toMatch(/denied by default/);
  });
});
