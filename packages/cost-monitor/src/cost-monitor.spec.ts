import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '@trustos/model-registry';
import { CostMonitor, formatCents, startOfDay, startOfMonth } from './cost';
import { InMemoryCostStore } from './testing';

let clock = new Date('2026-10-15T10:00:00Z');
let counter = 0;

const MODEL = {
  id: 'test.small',
  provider: 'testprovider',
  providerModelId: 'small-1',
  displayName: 'Small',
  capabilities: ['text'],
  contextTokens: 128_000,
  maxOutputTokens: 8_000,
  pricing: {
    inputCentsPerMillion: 300,
    outputCentsPerMillion: 1500,
    verifiedAt: new Date('2026-09-01'),
  },
};

function setup(options: { onAlert?: (alert: unknown) => void } = {}) {
  const store = new InMemoryCostStore();
  const registry = new ModelRegistry({ models: [MODEL], now: () => clock });

  const monitor = new CostMonitor({
    store,
    registry,
    onAlert: options.onAlert as never,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { store, monitor, registry };
}

const context = {
  organizationId: 'org_1' as string | null,
  actorId: 'usr_1' as string | null,
  application: 'support-api',
};

const usage = (overrides: Record<string, unknown> = {}) => ({
  promptTokens: 1_000_000,
  completionTokens: 100_000,
  reasoningTokens: 0,
  cachedPromptTokens: 0,
  totalTokens: 1_100_000,
  estimated: false,
  ...overrides,
});

beforeEach(() => {
  clock = new Date('2026-10-15T10:00:00Z');
  counter = 0;
});

describe('recording', () => {
  it('computes cost from the registry pricing', async () => {
    const { monitor } = setup();

    const entry = await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 800,
      outcome: 'stop',
    });

    // 1M input at 300c + 0.1M output at 1500c.
    expect(entry?.costCents).toBeCloseTo(450, 6);
  });

  it('records zero for an unknown model rather than guessing a price', async () => {
    // A fabricated number in a financial report is worse than a zero somebody can investigate.
    const { monitor } = setup();

    const entry = await monitor.record({
      context,
      modelId: 'retired.model',
      usage: usage(),
      latencyMs: 100,
      outcome: 'stop',
    });

    expect(entry?.costCents).toBe(0);
    expect(entry?.provider).toBe('unknown');
  });

  it('never fails the request that produced it', async () => {
    // The work is done and the money spent; losing the answer as well is strictly worse.
    const { monitor, store } = setup();
    store.record = async () => {
      throw new Error('the database is down');
    };

    await expect(
      monitor.record({
        context,
        modelId: 'test.small',
        usage: usage(),
        latencyMs: 1,
        outcome: 'stop',
      }),
    ).resolves.toBeNull();
  });

  it('carries the agent and prompt through for attribution', async () => {
    const { monitor } = setup();

    const entry = await monitor.record({
      context: { ...context, agentId: 'researcher', promptId: 'support.reply' },
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    expect(entry).toMatchObject({ agentId: 'researcher', promptKey: 'support.reply' });
  });
});

describe('totals and reporting', () => {
  async function withEntries() {
    const { monitor, store } = setup();

    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });
    await monitor.record({
      context: { ...context, application: 'other-api' },
      modelId: 'test.small',
      usage: usage({ estimated: true }),
      latencyMs: 1,
      outcome: 'stop',
    });
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage({ estimated: true }),
      latencyMs: 1,
      outcome: 'stop',
      cached: true,
    });

    return { monitor, store };
  }

  it('sums cost and tokens for a tenant', async () => {
    const { monitor } = await withEntries();
    const totals = await monitor.totals({ organizationId: 'org_1' });

    expect(totals.requests).toBe(3);
    expect(totals.costCents).toBeCloseTo(1350, 4);
  });

  it('does not include another tenant', async () => {
    const { monitor } = await withEntries();

    expect((await monitor.totals({ organizationId: 'org_2' })).requests).toBe(0);
  });

  it('tracks how much of the total is estimated', async () => {
    // A report that cannot say this is one nobody can reconcile against an invoice.
    const { monitor } = await withEntries();
    const report = await monitor.report({ organizationId: 'org_1' });

    expect(report.estimatedFraction).toBeCloseTo(2 / 3, 4);
    expect(report.caveat).toMatch(/will not reconcile exactly against an invoice/);
  });

  it('omits the caveat when almost everything is measured', async () => {
    const { monitor } = setup();
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    expect((await monitor.report({ organizationId: 'org_1' })).caveat).toBeNull();
  });

  it('reports a cache hit rate', async () => {
    const { monitor } = await withEntries();

    expect((await monitor.report({ organizationId: 'org_1' })).cacheHitRate).toBeCloseTo(1 / 3, 4);
  });

  it('breaks down by application and by day', async () => {
    const { monitor } = await withEntries();

    expect(
      (await monitor.breakdown({ organizationId: 'org_1' }, 'application')).map((e) => e.key),
    ).toEqual(['other-api', 'support-api']);
    expect((await monitor.breakdown({ organizationId: 'org_1' }, 'day')).map((e) => e.key)).toEqual(
      ['2026-10-15'],
    );
  });

  it('rounds once, at the point money is reported', async () => {
    // Rounding each call accumulates error in the direction of whoever rounds.
    const { monitor } = setup();

    for (let index = 0; index < 1000; index += 1) {
      await monitor.record({
        context,
        modelId: 'test.small',
        usage: usage({ promptTokens: 1000, completionTokens: 0, totalTokens: 1000 }),
        latencyMs: 1,
        outcome: 'stop',
      });
    }

    // 1000 calls × 0.3c. Rounding each to zero would lose all of it.
    expect((await monitor.report({ organizationId: 'org_1' })).totalCostCents).toBeCloseTo(300, 2);
  });
});

describe('budgets', () => {
  const budget = (overrides: Record<string, unknown> = {}) => ({
    maxCostCentsPerRequest: null,
    maxCostCentsPerDay: null,
    maxCostCentsPerMonth: null,
    warnAtFraction: 0.8,
    ...overrides,
  });

  it('refuses a single request over the per-request ceiling', async () => {
    const { monitor } = setup();

    const result = await monitor.checkBudget({
      organizationId: 'org_1',
      budget: budget({ maxCostCentsPerRequest: 50 }),
      estimatedCostCents: 120,
    });

    expect(result.allowed).toBe(false);
    expect(result.alerts[0]?.period).toBe('request');
  });

  it('warns before the daily budget is reached', async () => {
    // Reaching a budget with no prior signal is how an AI feature gets switched off in business
    // hours.
    const { monitor } = setup();
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    const result = await monitor.checkBudget({
      organizationId: 'org_1',
      budget: budget({ maxCostCentsPerDay: 500 }),
    });

    expect(result.allowed).toBe(true);
    expect(result.alerts[0]?.level).toBe('warning');
  });

  it('refuses once the daily budget is exceeded', async () => {
    const { monitor } = setup();
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    const result = await monitor.checkBudget({
      organizationId: 'org_1',
      budget: budget({ maxCostCentsPerDay: 100 }),
    });

    expect(result.allowed).toBe(false);
    expect(result.alerts[0]?.message).toMatch(/refused until the budget resets or is raised/);
  });

  it('counts the estimated cost of the pending request against the budget', async () => {
    const { monitor } = setup();

    const result = await monitor.checkBudget({
      organizationId: 'org_1',
      budget: budget({ maxCostCentsPerDay: 100 }),
      estimatedCostCents: 150,
    });

    expect(result.allowed).toBe(false);
  });

  it('separates a day budget from a month budget', async () => {
    const { monitor } = setup();
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    clock = new Date('2026-10-16T10:00:00Z');

    const result = await monitor.checkBudget({
      organizationId: 'org_1',
      budget: budget({ maxCostCentsPerDay: 100, maxCostCentsPerMonth: 10_000 }),
    });

    // Yesterday's spend is outside today's window but inside the month's.
    expect(result.allowed).toBe(true);
  });

  it('fires the alert handler for warnings as well as breaches', async () => {
    const onAlert = vi.fn();
    const { monitor } = setup({ onAlert });
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    await monitor.checkBudget({
      organizationId: 'org_1',
      budget: budget({ maxCostCentsPerDay: 500 }),
    });

    expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('does not let a failing alert handler break the budget check', async () => {
    const { monitor } = setup({
      onAlert: () => {
        throw new Error('notification service down');
      },
    });
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    await expect(
      monitor.checkBudget({ organizationId: 'org_1', budget: budget({ maxCostCentsPerDay: 100 }) }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('throws from assertBudget when over', async () => {
    const { monitor } = setup();
    await monitor.record({
      context,
      modelId: 'test.small',
      usage: usage(),
      latencyMs: 1,
      outcome: 'stop',
    });

    await expect(
      monitor.assertBudget({ organizationId: 'org_1', budget: budget({ maxCostCentsPerDay: 10 }) }),
    ).rejects.toThrow(/over its 10c budget/);
  });

  it('allows everything when no budget is set', async () => {
    const { monitor } = setup();

    expect((await monitor.checkBudget({ organizationId: 'org_1', budget: budget() })).allowed).toBe(
      true,
    );
  });
});

describe('formatting', () => {
  it.each([
    [0.004, '0.004c'],
    [0.5, '0.500c'],
    [12.345, '12.35c'],
    [450, '$4.50'],
  ])('formats %d cents as %s', (cents, expected) => {
    expect(formatCents(cents)).toBe(expected);
  });

  it('computes UTC period boundaries', () => {
    expect(startOfDay(new Date('2026-10-15T23:30:00Z')).toISOString()).toBe(
      '2026-10-15T00:00:00.000Z',
    );
    expect(startOfMonth(new Date('2026-10-15T23:30:00Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});
