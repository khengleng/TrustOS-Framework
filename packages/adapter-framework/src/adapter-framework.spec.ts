import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { retryPolicySchema } from '@trustsystem/retry';
import {
  BaseProvider,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderHealth,
} from '@trustsystem/provider-sdk';
import { ProviderRegistry } from './registry';

const NO_RETRY = retryPolicySchema.parse({ maxAttempts: 0 });

const configSchema = z.object({
  host: z.string().min(1),
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().default(5000),
});

type TestConfig = z.infer<typeof configSchema>;

class TestProvider extends BaseProvider<TestConfig> {
  readonly key = 'test.provider';
  readonly description = 'A provider for tests.';
  readonly configSchema = configSchema;

  initializeCalls = 0;
  shutdownCalls = 0;
  healthStatus: ProviderHealth['status'] = 'healthy';
  failInitialize = false;
  throwOnHealth = false;

  protected async onInitialize(): Promise<void> {
    this.initializeCalls += 1;
    if (this.failInitialize) throw new Error('cannot reach the host');
  }

  protected async checkHealth() {
    if (this.throwOnHealth) throw new Error('the check itself blew up');
    return { status: this.healthStatus, detail: 'reachable' };
  }

  protected async onShutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  capabilities(): ProviderCapabilities {
    return { category: 'test', features: { batching: true, batchSize: 100 } };
  }

  /** Exercised through `registry.call`. */
  async work(): Promise<string> {
    return `worked against ${this.requireConfig().host}`;
  }
}

function makeRegistry() {
  return new ProviderRegistry({ serviceName: 'test-app', environment: 'test' });
}

const validConfig = { host: 'api.example.com', apiKey: 'secret-value' };

describe('the base provider', () => {
  it('redacts secret-named configuration', async () => {
    const provider = new TestProvider();
    await provider.initialize(configSchema.parse(validConfig), context());

    const view = provider.configuration();
    expect(view.values.host).toBe('api.example.com');
    expect(view.values.apiKey).toBe('[REDACTED]');
    expect(view.redactedFields).toEqual(['apiKey']);
  });

  it('reports an unset secret as null rather than hidden', async () => {
    // An operator debugging a missing credential needs to tell "not configured" from "hidden".
    const provider = new TestProvider();
    await provider.initialize({ host: 'h', apiKey: '', timeoutMs: 1 } as TestConfig, context());

    expect(provider.configuration().values.apiKey).toBeNull();
    expect(provider.configuration().redactedFields).toEqual([]);
  });

  it('turns a throwing health check into critical with the reason', async () => {
    // `unknown` tells an operator strictly less than `critical` plus the message.
    const provider = new TestProvider();
    provider.throwOnHealth = true;
    await provider.initialize(configSchema.parse(validConfig), context());

    const health = await provider.health();
    expect(health.status).toBe('critical');
    expect(health.detail).toMatch(/the check itself blew up/);
  });

  it('reports critical before initialization', async () => {
    expect((await new TestProvider().health()).status).toBe('critical');
  });

  it('times the health check', async () => {
    const provider = new TestProvider();
    await provider.initialize(configSchema.parse(validConfig), context());

    expect((await provider.health()).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent on shutdown, because shutdown can race a health check', async () => {
    const provider = new TestProvider();
    await provider.initialize(configSchema.parse(validConfig), context());

    await provider.shutdown();
    await provider.shutdown();

    expect(provider.shutdownCalls).toBe(1);
  });

  it('does not throw when shutdown fails', async () => {
    // A provider that threw here would stop the others shutting down, turning one bad adapter
    // into a process that will not exit.
    class Broken extends TestProvider {
      protected override async onShutdown(): Promise<void> {
        throw new Error('the socket refused to close');
      }
    }

    const provider = new Broken();
    await provider.initialize(configSchema.parse(validConfig), context());

    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('explains a use-before-initialize rather than dereferencing null', async () => {
    // `work` is async, so the throw surfaces as a rejection rather than synchronously.
    await expect(new TestProvider().work()).rejects.toThrow(/before it was initialized/);
  });
});

describe('registration', () => {
  it('validates configuration before initializing', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();

    await expect(registry.register(provider, { host: 'h' })).rejects.toThrow(/not valid/);

    // The provider never saw the bad config, so an implementation may assume validity.
    expect(provider.initializeCalls).toBe(0);
  });

  it('applies schema defaults before initializing', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();
    await registry.register(provider, validConfig);

    expect(provider.configuration().values.timeoutMs).toBe(5000);
  });

  it('refuses two providers under one key', async () => {
    const registry = makeRegistry();
    await registry.register(new TestProvider(), validConfig);

    await expect(registry.register(new TestProvider(), validConfig)).rejects.toThrow(
      /already registered/,
    );
  });

  it('does not fail start-up when a provider cannot initialize', async () => {
    // Refusing to boot because the SMS gateway is misconfigured takes down every request,
    // including the ones that do not use it.
    const registry = makeRegistry();
    const provider = new TestProvider();
    provider.failInitialize = true;

    const result = await registry.register(provider, validConfig);

    expect(result.ready).toBe(false);
    expect(result.error).toMatch(/cannot reach the host/);
  });

  it('keeps a failed provider visible rather than silently absent', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();
    provider.failInitialize = true;
    await registry.register(provider, validConfig);

    expect(registry.describe()).toHaveLength(1);
    expect(registry.describe()[0]?.status).toBe('failed');
    expect(registry.has('test.provider')).toBe(false);
  });

  it('explains why a failed provider is unavailable when it is requested', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();
    provider.failInitialize = true;
    await registry.register(provider, validConfig);

    // "not available: cannot reach the host" is actionable; `undefined` is a null dereference
    // three frames later.
    expect(() => registry.get('test.provider')).toThrow(/cannot reach the host/);
  });

  it('lists what is registered when asked for something unknown', async () => {
    const registry = makeRegistry();
    await registry.register(new TestProvider(), validConfig);

    expect(() => registry.get('test.missing')).toThrow(/Registered: test\.provider/);
  });

  it('returns null from find rather than throwing, for a caller with a fallback', async () => {
    expect(makeRegistry().find('test.missing')).toBeNull();
  });
});

describe('categories', () => {
  it('groups substitutable providers', async () => {
    const registry = makeRegistry();

    class Second extends TestProvider {
      override readonly key = 'test.second';
    }

    await registry.register(new TestProvider(), validConfig);
    await registry.register(new Second(), validConfig);

    expect(registry.byCategory('test')).toHaveLength(2);
    expect(registry.byCategory('mail')).toHaveLength(0);
  });

  it('omits a failed provider from its category', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();
    provider.failInitialize = true;
    await registry.register(provider, validConfig);

    expect(registry.byCategory('test')).toHaveLength(0);
  });
});

describe('calling through the registry', () => {
  it('runs the operation and returns its result', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();
    await registry.register(provider, validConfig);

    const result = await registry.call<string>(
      'test.provider',
      'work',
      (p) => (p as TestProvider).work(),
      { retry: NO_RETRY },
    );

    expect(result).toBe('worked against api.example.com');
  });

  it('retries a transient failure', async () => {
    const registry = makeRegistry();
    await registry.register(new TestProvider(), validConfig);

    let attempts = 0;
    const result = await registry.call<string>(
      'test.provider',
      'flaky',
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporarily unavailable');
        return 'eventually';
      },
      { retry: retryPolicySchema.parse({ maxAttempts: 3, initialDelayMs: 0, jitter: 'none' }) },
    );

    expect(result).toBe('eventually');
    expect(attempts).toBe(3);
  });

  it('opens the circuit after sustained failure, so callers fail fast', async () => {
    const registry = makeRegistry();
    await registry.register(new TestProvider(), validConfig);

    const failing = () =>
      registry.call(
        'test.provider',
        'down',
        async () => {
          throw new Error('downstream is gone');
        },
        { retry: NO_RETRY },
      );

    for (let i = 0; i < 10; i += 1) {
      await failing().catch(() => {});
    }

    // Without a breaker, every request waits out the full retry schedule against a service that
    // is not coming back within the request's lifetime.
    expect(registry.describe()[0]?.circuit).toBe('open');
  });
});

describe('health', () => {
  it('reports every provider, ready or not', async () => {
    const registry = makeRegistry();

    class Failing extends TestProvider {
      override readonly key = 'test.failing';
    }

    const failing = new Failing();
    failing.failInitialize = true;

    await registry.register(new TestProvider(), validConfig);
    await registry.register(failing, validConfig);

    const health = await registry.healthAll();

    expect(health.map((entry) => [entry.key, entry.health.status])).toEqual([
      ['test.failing', 'critical'],
      ['test.provider', 'healthy'],
    ]);
  });

  it('checks providers concurrently rather than serially', async () => {
    /*
     * Compared against one provider rather than against the clock.
     *
     * A serial check takes as long as the sum of the timeouts, which is exactly when
     * the endpoint is most likely to be scraped. The old form asserted an absolute
     * 60ms for two 30ms providers and failed at 69ms under a loaded machine, on code
     * that was checking them concurrently perfectly well. Timing one provider in the
     * same conditions gives a baseline that moves with the load, and four providers
     * make the serial case four times the baseline instead of twice — far enough
     * outside the noise to tell the two apart.
     */
    const DELAY_MS = 30;

    class Slow extends TestProvider {
      // Assigned in the constructor, not as a field initializer: the base class sets
      // `key` as an own property during super(), which would shadow anything declared
      // on the subclass prototype and register every instance under the same key.
      override readonly key: string;

      constructor(suffix: string) {
        super();
        this.key = `test.slow_${suffix}`;
      }

      protected override async checkHealth() {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        return { status: 'healthy' as const, detail: 'slow but fine' };
      }
    }

    const timeHealthAll = async (count: number) => {
      const registry = makeRegistry();
      for (let index = 0; index < count; index += 1) {
        await registry.register(new Slow(String(index)), validConfig);
      }

      const startedAt = Date.now();
      await registry.healthAll();
      return Date.now() - startedAt;
    };

    const one = await timeHealthAll(1);
    const four = await timeHealthAll(4);

    // Concurrent: about the same as one. Serial: about four times it.
    expect(four).toBeLessThan(Math.max(one, DELAY_MS) * 2.5);
  }, 30_000);

  it('records the last health in describe', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();
    provider.healthStatus = 'warning';
    await registry.register(provider, validConfig);

    await registry.healthAll();

    expect(registry.describe()[0]?.lastHealth?.status).toBe('warning');
  });
});

describe('describe', () => {
  it('never leaks a secret', async () => {
    const registry = makeRegistry();
    await registry.register(new TestProvider(), validConfig);

    expect(JSON.stringify(registry.describe())).not.toContain('secret-value');
  });

  it('survives a provider whose own methods throw', async () => {
    // A `describe` that threw would break the very command an operator runs to find out what is
    // wrong.
    class Hostile extends TestProvider {
      override readonly key = 'test.hostile';
      override capabilities(): ProviderCapabilities {
        throw new Error('no');
      }
    }

    const registry = makeRegistry();
    const hostile = new Hostile();
    hostile.failInitialize = true;
    await registry.register(hostile, validConfig);

    expect(registry.describe()[0]?.capabilities).toBeNull();
  });
});

describe('shutdown', () => {
  it('shuts every provider down and signals them', async () => {
    const registry = makeRegistry();
    const provider = new TestProvider();
    let signalled = false;

    await registry.register(provider, validConfig);
    (provider as unknown as { context: ProviderContext }).context.signal.addEventListener(
      'abort',
      () => {
        signalled = true;
      },
    );

    await registry.shutdownAll();

    expect(provider.shutdownCalls).toBe(1);
    expect(signalled).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('does not let one bad shutdown stop the others', async () => {
    class Hostile extends TestProvider {
      override readonly key = 'test.hostile';
      override async shutdown(): Promise<void> {
        throw new Error('refuses to close');
      }
    }

    const registry = makeRegistry();
    const good = new TestProvider();
    await registry.register(new Hostile(), validConfig);
    await registry.register(good, validConfig);

    await expect(registry.shutdownAll()).resolves.toBeUndefined();
    expect(good.shutdownCalls).toBe(1);
  });
});

function context(): ProviderContext {
  return {
    serviceName: 'test-app',
    environment: 'test',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
  };
}
