import { beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITIES, computeCost, isVisibleTo, pricingAgeDays } from './model';
import { ModelRegistry } from './registry';

let clock = new Date('2026-10-01T10:00:00Z');

const pricing = {
  inputCentsPerMillion: 25,
  outputCentsPerMillion: 100,
  verifiedAt: new Date('2026-09-01T00:00:00Z'),
};

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test.small',
    provider: 'testprovider',
    providerModelId: 'test-small-v1',
    displayName: 'Test Small',
    capabilities: [CAPABILITIES.TEXT, CAPABILITIES.TOOLS, CAPABILITIES.STREAMING],
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    pricing,
    ...overrides,
  };
}

function registry(models: unknown[] = [model()]) {
  return new ModelRegistry({ models, now: () => clock });
}

function issuesOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    const details = (error as { details?: Array<{ path: string; message: string }> }).details ?? [];
    return [(error as Error).message, ...details.map((e) => `${e.path}: ${e.message}`)].join(' | ');
  }
  throw new Error('Expected the call to throw, and it did not.');
}

beforeEach(() => {
  clock = new Date('2026-10-01T10:00:00Z');
});

describe('registration', () => {
  it('names the offending field when configuration is wrong', () => {
    // This runs at start-up from hand-written configuration; a mistake found at boot is minutes,
    // the same mistake at the first request is an incident.
    expect(issuesOf(() => registry([model({ contextTokens: 0 })]))).toMatch(
      /test\.small\.contextTokens/,
    );
  });

  it('refuses a model that generates more than its context holds', () => {
    expect(
      issuesOf(() => registry([model({ contextTokens: 4_000, maxOutputTokens: 8_000 })])),
    ).toMatch(/copied from the wrong row/);
  });

  it('refuses a deprecated model with no replacement', () => {
    // "Deprecated" with no replacement tells somebody they have a problem and not what to do.
    expect(issuesOf(() => registry([model({ status: 'deprecated' })]))).toMatch(
      /must name its replacement/,
    );
  });

  it('refuses two models under one id', () => {
    expect(issuesOf(() => registry([model(), model()]))).toMatch(/already registered/);
  });

  it('accepts a deprecated model whose replacement is registered later', () => {
    // Configuration order is arbitrary; a deprecated model is often listed before its successor.
    expect(() =>
      registry([
        model({ status: 'deprecated', supersededBy: 'test.large' }),
        model({ id: 'test.large' }),
      ]),
    ).not.toThrow();
  });
});

describe('catalog validation', () => {
  it('reports a dangling replacement without refusing to boot', () => {
    // The models that are correct still work, and the problem belongs in `ai doctor`.
    const target = registry([model({ status: 'deprecated', supersededBy: 'test.gone' })]);

    expect(target.validate().join(' ')).toMatch(/not registered/);
  });

  it('reports stale pricing', () => {
    clock = new Date('2027-06-01T00:00:00Z');
    const target = registry();

    expect(target.validate().join(' ')).toMatch(/pricing last verified \d+ days ago/);
  });

  it('reports an empty catalog and explains why the framework ships none', () => {
    expect(new ModelRegistry().validate().join(' ')).toMatch(/framework ships none deliberately/);
  });

  it('is silent for a healthy catalog', () => {
    expect(registry().validate()).toEqual([]);
  });
});

describe('lookup', () => {
  it('lists what is registered when an id is unknown', () => {
    expect(issuesOf(() => registry().get('gpt-9'))).toMatch(/Registered: test\.small/);
  });

  it('explains a retirement rather than reporting an unknown model', () => {
    // "Unknown model" for something that existed last month sends somebody looking for a typo.
    const target = registry([
      model({ status: 'retired', supersededBy: 'test.large' }),
      model({ id: 'test.large' }),
    ]);

    expect(issuesOf(() => target.get('test.small'))).toMatch(/retired; use "test\.large"/);
  });

  it('returns a deprecated model, because it is still usable', () => {
    const target = registry([
      model({ status: 'deprecated', supersededBy: 'test.large' }),
      model({ id: 'test.large' }),
    ]);

    expect(target.get('test.small').status).toBe('deprecated');
  });

  it('returns null from find rather than throwing', () => {
    expect(registry().find('nope')).toBeNull();
  });
});

describe('tenant visibility', () => {
  const restricted = () =>
    registry([model(), model({ id: 'test.private', allowedOrganizationIds: ['org_1'] })]);

  it('shows an unrestricted model to everybody', () => {
    // Through the registry, because `allowedOrganizationIds` is a schema default and only exists
    // once the configuration has been parsed.
    expect(isVisibleTo(registry().get('test.small'), null)).toBe(true);
    expect(isVisibleTo(registry().get('test.small'), 'org_9')).toBe(true);
  });

  it('hides a restricted model from other tenants', () => {
    expect(
      restricted()
        .list({ organizationId: 'org_2' })
        .map((m) => m.id),
    ).toEqual(['test.small']);
    expect(
      restricted()
        .list({ organizationId: 'org_1' })
        .map((m) => m.id),
    ).toEqual(['test.private', 'test.small']);
  });

  it('reports a hidden model as unknown rather than forbidden', () => {
    // Confirming it exists tells a tenant something about another tenant's arrangements.
    expect(issuesOf(() => restricted().get('test.private', 'org_2'))).toMatch(/No model/);
  });

  it('hides a tenant-restricted model from platform scope', () => {
    expect(restricted().find('test.private', null)).toBeNull();
  });
});

describe('filtering', () => {
  const many = () =>
    registry([
      model({ id: 'a.cheap', pricing: { ...pricing, inputCentsPerMillion: 10 } }),
      model({
        id: 'b.big',
        contextTokens: 1_000_000,
        capabilities: ['text', 'tools', 'streaming', 'json_schema'],
      }),
      model({ id: 'c.other', provider: 'otherprovider', capabilities: ['text'] }),
    ]);

  it('filters on every requested capability, not any', () => {
    expect(
      many()
        .list({ capabilities: ['tools', 'json_schema'] })
        .map((m) => m.id),
    ).toEqual(['b.big']);
  });

  it('filters on context window', () => {
    expect(
      many()
        .list({ minContextTokens: 500_000 })
        .map((m) => m.id),
    ).toEqual(['b.big']);
  });

  it('filters on input cost', () => {
    expect(
      many()
        .list({ maxInputCostPerMillion: 15 })
        .map((m) => m.id),
    ).toEqual(['a.cheap']);
  });

  it('filters on provider', () => {
    expect(
      many()
        .list({ provider: 'otherprovider' })
        .map((m) => m.id),
    ).toEqual(['c.other']);
  });

  it('orders stably, so routing is deterministic across processes', () => {
    // An unstable order turns a routing bug into one that reproduces on one pod out of three.
    expect(
      many()
        .list()
        .map((m) => m.id),
    ).toEqual(['a.cheap', 'b.big', 'c.other']);
  });

  it('omits retired models by default', () => {
    const target = registry([model(), model({ id: 'test.old', status: 'retired' })]);

    expect(target.list().map((m) => m.id)).toEqual(['test.small']);
    expect(target.list({ includeRetired: true }).map((m) => m.id)).toEqual([
      'test.old',
      'test.small',
    ]);
  });
});

describe('runtime availability', () => {
  it('routes around a model the gateway marked unavailable', () => {
    const target = registry([model(), model({ id: 'test.large' })]);

    target.markUnavailable('test.small', 'provider returned 503');

    expect(target.isAvailableNow('test.small')).toBe(false);
    expect(target.available().map((m) => m.id)).toEqual(['test.large']);
  });

  it('brings it back on its own, because a permanent override never gets cleared', () => {
    const target = registry();
    target.markUnavailable('test.small', 'blip');

    clock = new Date(clock.getTime() + 16 * 60_000);

    expect(target.isAvailableNow('test.small')).toBe(true);
  });

  it('lets an operator clear an override early', () => {
    const target = registry();
    target.markUnavailable('test.small', 'outage');
    target.markAvailable('test.small');

    expect(target.isAvailableNow('test.small')).toBe(true);
  });

  it('treats a configured unavailable status as unavailable too', () => {
    expect(registry([model({ status: 'unavailable' })]).isAvailableNow('test.small')).toBe(false);
  });

  it('ignores an override for a model that does not exist', () => {
    const target = registry();
    expect(() => target.markUnavailable('nope', 'x')).not.toThrow();
  });
});

describe('cost', () => {
  const priced = {
    ...model(),
    pricing: {
      inputCentsPerMillion: 300,
      outputCentsPerMillion: 1500,
      cachedInputCentsPerMillion: 30,
      verifiedAt: new Date('2026-09-01'),
    },
  } as never;

  it('computes cents from tokens', () => {
    // 1M input at 300c + 1M output at 1500c.
    expect(computeCost(priced, { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBe(
      1800,
    );
  });

  it('does not bill a cached token twice', () => {
    // The most common way an AI cost report comes out higher than the invoice.
    const cost = computeCost(priced, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
    });

    expect(cost).toBe(30);
  });

  it('bills reasoning tokens at the output rate when no separate rate is set', () => {
    expect(
      computeCost(priced, { promptTokens: 0, completionTokens: 0, reasoningTokens: 1_000_000 }),
    ).toBe(1500);
  });

  it('keeps sub-cent precision rather than rounding each call', () => {
    // Rounding per call accumulates error in the direction of whoever rounds.
    const cost = computeCost(priced, { promptTokens: 1000, completionTokens: 0 });

    expect(cost).toBeCloseTo(0.3, 10);
  });

  it('is zero for zero usage', () => {
    expect(computeCost(priced, { promptTokens: 0, completionTokens: 0 })).toBe(0);
  });
});

describe('pricing age', () => {
  it('counts days since the price was confirmed', () => {
    expect(pricingAgeDays(registry().get('test.small'), clock)).toBe(30);
  });
});

describe('describe', () => {
  it('reports availability now, not just configured status', () => {
    const target = registry();
    target.markUnavailable('test.small', 'outage');

    const [entry] = target.describe();
    expect(entry).toMatchObject({ status: 'available', availableNow: false });
  });

  it('includes retired models, so a listing explains a disappearance', () => {
    const target = registry([model({ status: 'retired' })]);

    expect(target.describe().map((entry) => entry.id)).toEqual(['test.small']);
  });

  it('lists the providers in use', () => {
    const target = registry([model(), model({ id: 'b', provider: 'otherprovider' })]);

    expect(target.providers()).toEqual(['otherprovider', 'testprovider']);
  });
});
