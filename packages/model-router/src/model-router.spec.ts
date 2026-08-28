import { describe, expect, it } from 'vitest';
import { AiPolicyEngine } from '@trustos/ai-policy';
import { ModelRegistry } from '@trustos/model-registry';
import { ModelRouter } from './router';

const pricing = (input: number) => ({
  inputCentsPerMillion: input,
  outputCentsPerMillion: input * 4,
  verifiedAt: new Date('2026-09-01'),
});

const MODELS = [
  {
    id: 'a.cheap',
    provider: 'alpha',
    providerModelId: 'cheap-1',
    displayName: 'Cheap',
    capabilities: ['text', 'tools', 'streaming'],
    contextTokens: 32_000,
    maxOutputTokens: 4_000,
    p50LatencyMs: 900,
    pricing: pricing(10),
  },
  {
    id: 'b.fast',
    provider: 'alpha',
    providerModelId: 'fast-1',
    displayName: 'Fast',
    capabilities: ['text', 'tools', 'streaming'],
    contextTokens: 64_000,
    maxOutputTokens: 8_000,
    p50LatencyMs: 250,
    pricing: pricing(40),
  },
  {
    id: 'c.big',
    provider: 'beta',
    providerModelId: 'big-1',
    displayName: 'Big',
    capabilities: ['text', 'tools', 'streaming', 'json_schema'],
    contextTokens: 1_000_000,
    maxOutputTokens: 32_000,
    // No measured latency, deliberately: an unmeasured model must not win a latency route.
    pricing: pricing(120),
  },
];

function router(options: { models?: unknown[]; policies?: unknown[]; profiles?: unknown[] } = {}) {
  const registry = new ModelRegistry({ models: options.models ?? MODELS });
  const policy = options.policies ? new AiPolicyEngine(options.policies) : undefined;

  return {
    registry,
    router: new ModelRouter({ registry, policy, profiles: options.profiles }),
  };
}

const requirement = (overrides: Record<string, unknown> = {}) => ({
  kind: 'requirement' as const,
  capabilities: [],
  ...overrides,
});

describe('routing on a profile', () => {
  it('chooses the cheapest on the balanced profile', () => {
    const { router: target } = router();
    const decision = target.route({ selection: requirement(), organizationId: 'org_1' });

    expect(decision.model.id).toBe('a.cheap');
    expect(decision.reason).toMatch(/cheapest input price/);
  });

  it('chooses the lowest measured latency on the fast profile', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: requirement({ profile: 'fast' }),
      organizationId: 'org_1',
    });

    expect(decision.model.id).toBe('b.fast');
  });

  it('does not let an unmeasured model win a latency route', () => {
    // Treating null as zero would make every newly-added model the fastest in the catalogue.
    const { router: target } = router();
    const decision = target.route({
      selection: requirement({ profile: 'fast' }),
      organizationId: 'org_1',
    });

    expect(decision.model.id).not.toBe('c.big');
  });

  it('chooses the largest window on the deep profile', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: requirement({ profile: 'deep' }),
      organizationId: 'org_1',
    });

    expect(decision.model.id).toBe('c.big');
  });

  it('falls back to balanced for an unknown profile rather than failing', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: requirement({ profile: 'does-not-exist' }),
      organizationId: 'org_1',
    });

    expect(decision.profile).toBe('balanced');
  });

  it('honours a configured preference order', () => {
    const { router: target } = router({
      profiles: [{ name: 'house', optimise: 'order', preferredModels: ['c.big', 'a.cheap'] }],
    });

    const decision = target.route({
      selection: requirement({ profile: 'house' }),
      organizationId: 'org_1',
    });

    expect(decision.model.id).toBe('c.big');
    expect(decision.fallbacks.map((model) => model.id)).toEqual(['a.cheap', 'b.fast']);
  });

  it('lets a named preference beat a small price difference', () => {
    // Somebody naming a model in configuration is a stronger signal than two cents.
    const { router: target } = router({
      profiles: [{ name: 'house', optimise: 'cost', preferredModels: ['c.big'] }],
    });

    expect(
      target.route({ selection: requirement({ profile: 'house' }), organizationId: 'org_1' }).model
        .id,
    ).toBe('c.big');
  });
});

describe('determinism', () => {
  it('picks the same model every time for the same inputs', () => {
    // A router that picked differently between two pods would turn a bug into one that reproduces
    // on one request in three.
    const { router: target } = router();

    const choices = new Set(
      Array.from(
        { length: 20 },
        () => target.route({ selection: requirement(), organizationId: 'org_1' }).model.id,
      ),
    );

    expect(choices.size).toBe(1);
  });

  it('breaks a tie on model id rather than array order', () => {
    const tied = [
      { ...MODELS[0], id: 'z.tied', pricing: pricing(10) },
      { ...MODELS[0], id: 'a.tied', pricing: pricing(10) },
    ];

    const { router: target } = router({ models: tied });

    expect(target.route({ selection: requirement(), organizationId: 'org_1' }).model.id).toBe(
      'a.tied',
    );
  });
});

describe('capability and size filtering', () => {
  it('requires every capability, not any', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: requirement({ capabilities: ['json_schema'] }),
      organizationId: 'org_1',
    });

    expect(decision.model.id).toBe('c.big');
  });

  it('excludes a model whose window cannot hold the prompt', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: requirement(),
      organizationId: 'org_1',
      requiredContextTokens: 100_000,
    });

    expect(decision.model.id).toBe('c.big');
  });

  it('respects a cost ceiling', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: requirement({ profile: 'deep', maxInputCostPerMillion: 50 }),
      organizationId: 'org_1',
    });

    expect(decision.model.id).toBe('b.fast');
  });

  it('treats a preferred provider as a preference, not a filter', () => {
    // A preference that emptied the candidate list would be a filter wearing a softer name.
    const { router: target } = router();

    const decision = target.route({
      selection: requirement({ preferredProvider: 'gamma' }),
      organizationId: 'org_1',
    });

    expect(decision.model.id).toBe('a.cheap');
  });

  it('honours a preferred provider that does have candidates', () => {
    const { router: target } = router();

    const decision = target.route({
      selection: requirement({ preferredProvider: 'beta' }),
      organizationId: 'org_1',
    });

    expect(decision.model.provider).toBe('beta');
  });
});

describe('fallbacks', () => {
  it('offers fallbacks in rank order', () => {
    const { router: target } = router();
    const decision = target.route({ selection: requirement(), organizationId: 'org_1' });

    expect(decision.fallbacks.map((model) => model.id)).toEqual(['b.fast', 'c.big']);
  });

  it('routes around a model the registry marked unavailable', () => {
    const { registry, router: target } = router();
    registry.markUnavailable('a.cheap', 'provider 503');

    expect(target.route({ selection: requirement(), organizationId: 'org_1' }).model.id).toBe(
      'b.fast',
    );
  });

  it('caps the fallback chain, so a request does not spend thirty seconds finding nothing', () => {
    const { router: target } = router({
      profiles: [{ name: 'narrow', optimise: 'cost', maxCandidates: 2 }],
    });

    const decision = target.route({
      selection: requirement({ profile: 'narrow' }),
      organizationId: 'org_1',
    });

    expect(decision.fallbacks).toHaveLength(1);
  });
});

describe('explaining an empty result', () => {
  it('says when nothing is registered at all', () => {
    const { router: target } = router({ models: [] });

    expect(() => target.route({ selection: requirement(), organizationId: 'org_1' })).toThrow(
      /no models are registered/,
    );
  });

  it('says when everything is unavailable', () => {
    const { registry, router: target } = router();
    for (const model of MODELS) registry.markUnavailable(model.id, 'outage');

    expect(() => target.route({ selection: requirement(), organizationId: 'org_1' })).toThrow(
      /marked unavailable/,
    );
  });

  it('names the missing capability', () => {
    const { router: target } = router();

    expect(() =>
      target.route({
        selection: requirement({ capabilities: ['vision'] }),
        organizationId: 'org_1',
      }),
    ).toThrow(/no model has every required capability \(vision\)/);
  });

  it('says the prompt is too long for anything registered', () => {
    const { router: target } = router();

    expect(() =>
      target.route({
        selection: requirement(),
        organizationId: 'org_1',
        requiredContextTokens: 5_000_000,
      }),
    ).toThrow(/context window of at least 5000000 tokens/);
  });

  it('says when the cost ceiling excluded everything', () => {
    const { router: target } = router();

    expect(() =>
      target.route({
        selection: requirement({ maxInputCostPerMillion: 1 }),
        organizationId: 'org_1',
      }),
    ).toThrow(/Raise the ceiling or register a cheaper model/);
  });

  it('says when policy excluded everything', () => {
    const { router: target } = router({
      policies: [
        {
          name: 'locked',
          scope: { kind: 'organization', organizationId: 'org_1' },
          allowedModels: ['not.registered'],
        },
      ],
    });

    expect(() => target.route({ selection: requirement(), organizationId: 'org_1' })).toThrow(
      /denied by the tenant’s AI policy/,
    );
  });
});

describe('an explicitly named model', () => {
  it('is used as asked', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: { kind: 'model', modelId: 'c.big' },
      organizationId: 'org_1',
    });

    expect(decision.model.id).toBe('c.big');
    expect(decision.profile).toBe('explicit');
  });

  it('gets no fallback, because substituting would produce output from a model nobody chose', () => {
    const { router: target } = router();
    const decision = target.route({
      selection: { kind: 'model', modelId: 'c.big' },
      organizationId: 'org_1',
    });

    expect(decision.fallbacks).toEqual([]);
  });

  it('does not bypass policy', () => {
    const { router: target } = router({
      policies: [
        {
          name: 'locked',
          scope: { kind: 'organization', organizationId: 'org_1' },
          allowedModels: ['a.cheap'],
        },
      ],
    });

    expect(() =>
      target.route({ selection: { kind: 'model', modelId: 'c.big' }, organizationId: 'org_1' }),
    ).toThrow(/does not bypass policy/);
  });

  it('suggests asking for a requirement when the named model is down', () => {
    const { registry, router: target } = router();
    registry.markUnavailable('c.big', 'outage');

    expect(() =>
      target.route({ selection: { kind: 'model', modelId: 'c.big' }, organizationId: 'org_1' }),
    ).toThrow(/Ask for a requirement rather than a model/);
  });
});

describe('policy interaction', () => {
  it('excludes a model the tenant policy denies', () => {
    const { router: target } = router({
      policies: [
        {
          name: 'no-beta',
          scope: { kind: 'organization', organizationId: 'org_1' },
          deniedModels: ['a.cheap'],
        },
      ],
    });

    expect(target.route({ selection: requirement(), organizationId: 'org_1' }).model.id).toBe(
      'b.fast',
    );
  });

  it('excludes a provider the tenant may not use', () => {
    // The data-residency case.
    const { router: target } = router({
      policies: [
        {
          name: 'residency',
          scope: { kind: 'organization', organizationId: 'org_1' },
          allowedProviders: ['beta'],
        },
      ],
    });

    expect(target.route({ selection: requirement(), organizationId: 'org_1' }).model.provider).toBe(
      'beta',
    );
  });

  it('applies an agent policy over a tenant policy', () => {
    const { router: target } = router({
      policies: [
        {
          name: 'tenant',
          scope: { kind: 'organization', organizationId: 'org_1' },
          allowedModels: ['a.cheap'],
        },
        {
          name: 'agent',
          scope: { kind: 'agent', agentId: 'researcher', organizationId: 'org_1' },
          allowedModels: ['c.big'],
        },
      ],
    });

    expect(
      target.route({ selection: requirement(), organizationId: 'org_1', agentId: 'researcher' })
        .model.id,
    ).toBe('c.big');
  });

  it('restricts to the models an agent declares', () => {
    const { router: target } = router();

    expect(
      target.route({
        selection: requirement(),
        organizationId: 'org_1',
        allowedModels: ['b.fast', 'c.big'],
      }).model.id,
    ).toBe('b.fast');
  });
});

describe('describe', () => {
  it('reports what each profile would currently choose', () => {
    const { router: target } = router();
    const described = target.describe('org_1');

    expect(described.map((entry) => entry.profile)).toEqual(['balanced', 'deep', 'fast']);
    expect(described.find((entry) => entry.profile === 'deep')?.wouldChoose).toBe('c.big');
  });

  it('reports the problem rather than throwing when a profile cannot route', () => {
    const { router: target } = router({ models: [] });

    expect(target.describe('org_1')[0]?.problem).toMatch(/no models are registered/);
  });
});
