import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BaseProvider, PROVIDER_HEALTH, type ProviderContext } from './index';

/**
 * The provider base class.
 *
 * Small, and that is exactly why it needs testing: every adapter inherits its lifecycle and its
 * configuration redaction, so a default here is a default in every provider at once. The two that
 * matter most are that a credential never appears in the configuration view — which reaches logs
 * and status pages — and that an uninitialized or shut-down provider reports `critical` rather
 * than something reassuring.
 */

const configSchema = z.object({ endpoint: z.string(), apiKey: z.string() });
type TestConfig = z.infer<typeof configSchema>;

class TestProvider extends BaseProvider<TestConfig> {
  readonly key = 'test';
  readonly description = 'A provider for tests.';
  readonly configSchema = configSchema as z.ZodType<TestConfig>;

  initializeCalls = 0;
  shutdownCalls = 0;
  healthResult: { status: 'healthy' | 'warning' | 'critical'; detail: string } = {
    status: 'healthy',
    detail: 'Reachable.',
  };
  healthThrows = false;

  protected async onInitialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  protected async onShutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  protected async checkHealth() {
    if (this.healthThrows) throw new Error('connection refused');
    return this.healthResult;
  }

  capabilities() {
    return { streaming: false, tools: false };
  }
}

const config: TestConfig = { endpoint: 'https://api.test', apiKey: 'sk-abcdefghijklmnop' };
const context = {} as ProviderContext;

async function initialized(): Promise<TestProvider> {
  const provider = new TestProvider();
  await provider.initialize(config, context);
  return provider;
}

describe('health', () => {
  it('names the four states it can report', () => {
    expect([...PROVIDER_HEALTH]).toEqual(['healthy', 'warning', 'critical', 'unknown']);
  });

  it('reports critical before initialization rather than something reassuring', async () => {
    /*
     * A provider that has never been initialized cannot serve a request. Reporting anything softer
     * makes a dashboard look survivable at the moment nothing works.
     */
    const health = await new TestProvider().health();

    expect(health.status).toBe('critical');
    expect(health.detail).toMatch(/not been initialized/);
  });

  it('reports the subclass verdict once initialized', async () => {
    const health = await (await initialized()).health();

    expect(health.status).toBe('healthy');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    expect(health.checkedAt).toBeInstanceOf(Date);
  });

  it('turns a throwing check into critical with the reason, never unknown', async () => {
    /*
     * `unknown` tells an operator strictly less than `critical` plus the message does. A check
     * that throws is a provider that is down, and saying so with the error attached is the whole
     * value of the wrapper.
     */
    const provider = await initialized();
    provider.healthThrows = true;

    const health = await provider.health();

    expect(health.status).toBe('critical');
    expect(health.detail).toContain('connection refused');
  });

  it('reports critical after shutdown', async () => {
    const provider = await initialized();
    await provider.shutdown();

    expect((await provider.health()).status).toBe('critical');
  });

  it('carries a warning through rather than flattening it', async () => {
    // Three states exist because degraded is a real one; collapsing it loses the early warning.
    const provider = await initialized();
    provider.healthResult = { status: 'warning', detail: 'Elevated latency.' };

    expect((await provider.health()).status).toBe('warning');
  });
});

describe('configuration', () => {
  it('never puts a credential in the view', async () => {
    // The configuration view reaches logs and status pages, and an adapter's config holds its key.
    const view = (await initialized()).configuration();

    expect(JSON.stringify(view)).not.toContain('sk-abcdefghijklmnop');
    expect(view.values.apiKey).toBe('[REDACTED]');
  });

  it('leaves non-secret fields readable, which is the point of having a view at all', async () => {
    expect((await initialized()).configuration().values.endpoint).toBe('https://api.test');
  });

  it('distinguishes an unset credential from a hidden one', async () => {
    /*
     * `[REDACTED]` and `null` mean different things to an operator debugging a missing credential:
     * one says "set, not shown", the other says "not set". Reporting both as redacted sends them
     * looking for a value that was never there.
     */
    const provider = new TestProvider();
    await provider.initialize({ endpoint: 'https://api.test', apiKey: '' }, context);

    const view = provider.configuration();

    expect(view.values.apiKey).toBeNull();
    expect(view.redactedFields).not.toContain('apiKey');
  });

  it('lists which fields it redacted', async () => {
    expect((await initialized()).configuration().redactedFields).toEqual(['apiKey']);
  });

  it('matches a secret field by substring, so `providerApiKey` is caught too', async () => {
    /*
     * Field names are not standardised across adapters. Exact matching would let
     * `providerApiKey`, `dbConnectionString` and `refreshToken` through — and the one that gets
     * through is always the one somebody named unusually.
     */
    const provider = new TestProvider();
    await provider.initialize({ providerApiKey: 'secret-value-here' } as never, context);

    expect(provider.configuration().values.providerApiKey).toBe('[REDACTED]');
  });
});

describe('lifecycle', () => {
  it('runs the subclass setup exactly once per initialization', async () => {
    expect((await initialized()).initializeCalls).toBe(1);
  });

  it('is idempotent on shutdown', async () => {
    /*
     * A shutdown can race a health check, so a second call must be harmless — and a provider that
     * threw on the second would stop the others shutting down at all.
     */
    const provider = await initialized();

    await provider.shutdown();
    await expect(provider.shutdown()).resolves.toBeUndefined();
    expect(provider.shutdownCalls).toBe(1);
  });

  it('does not run shutdown on a provider that was never initialized', async () => {
    const provider = new TestProvider();

    await provider.shutdown();

    expect(provider.shutdownCalls).toBe(0);
  });

  it('can be reinitialized after shutdown', async () => {
    // A provider whose configuration was corrected should come back without a process restart.
    const provider = await initialized();
    await provider.shutdown();
    await provider.initialize(config, context);

    expect((await provider.health()).status).toBe('healthy');
    expect(provider.initializeCalls).toBe(2);
  });
});
