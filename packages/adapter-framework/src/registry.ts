import { ApiError } from '@trustsystem/errors';
import type { LoggerPort } from '@trustsystem/logging';
import type { MetricsRecorder } from '@trustsystem/observability';
import {
  CircuitBreakerRegistry,
  RETRY_PRESETS,
  withRetry,
  type RetryPolicy,
} from '@trustsystem/retry';
import type {
  Provider,
  ProviderCapabilities,
  ProviderConfigurationView,
  ProviderHealth,
} from '@trustsystem/provider-sdk';

/**
 * The provider registry.
 *
 * Owns every provider's lifecycle: validate configuration, initialize, expose, health-check,
 * shut down. Three things it does that a plain map would not:
 *
 *   * **Configuration is validated before initialization.** A provider never sees a config it
 *     has not approved, so an implementation may assume validity — which removes a whole class of
 *     defensive checks from every adapter.
 *   * **A failed provider does not stop start-up.** It is registered as failed, `health()` reports
 *     `critical` with the reason, and the application boots. The alternative — refusing to start
 *     because the SMS gateway is misconfigured — takes down everything for a feature most
 *     requests do not use.
 *   * **Calls go through a circuit breaker.** A provider whose downstream is down should fail fast
 *     rather than tie up a request for thirty seconds per attempt. See `call`.
 */

export interface RegisteredProvider {
  provider: Provider;
  status: 'ready' | 'failed';
  /** Why initialization failed, when it did. */
  error: string | null;
  registeredAt: Date;
  lastHealth: ProviderHealth | null;
}

export interface ProviderRegistryOptions {
  serviceName: string;
  environment: string;
  logger?: LoggerPort;
  metrics?: MetricsRecorder;
  /** Shared across providers, so one flapping downstream does not trip another's breaker. */
  breakers?: CircuitBreakerRegistry;
  now?: () => Date;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly shutdownSignal = new AbortController();
  private readonly breakers: CircuitBreakerRegistry;
  private readonly now: () => Date;

  constructor(private readonly options: ProviderRegistryOptions) {
    this.breakers = options.breakers ?? new CircuitBreakerRegistry();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Registers and initializes a provider.
   *
   * Returns whether it came up. Does **not** throw on an initialization failure — see the class
   * header: refusing to boot because one optional integration is misconfigured takes down every
   * request, including the ones that do not use it.
   *
   * A configuration that does not *parse*, however, does throw. That is a deployment mistake
   * somebody can fix in seconds, and failing loudly at the point of registration is the fastest
   * way to tell them.
   */
  async register<TConfig>(
    provider: Provider<TConfig>,
    config: unknown,
  ): Promise<{ ready: boolean; error: string | null }> {
    if (this.providers.has(provider.key)) {
      throw ApiError.conflict(
        `A provider is already registered under "${provider.key}". Two providers sharing a key ` +
          'would make which one a caller gets depend on registration order.',
        { reason: 'provider_conflict', key: provider.key },
      );
    }

    const parsed = provider.configSchema.safeParse(config);

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `${provider.key}.${issue.path.join('.')}`,
          message: issue.message,
        })),
        `The configuration for provider "${provider.key}" is not valid.`,
      );
    }

    try {
      await provider.initialize(parsed.data, {
        serviceName: this.options.serviceName,
        environment: this.options.environment,
        logger: this.options.logger,
        signal: this.shutdownSignal.signal,
      });

      this.providers.set(provider.key, {
        provider: provider as Provider,
        status: 'ready',
        error: null,
        registeredAt: this.now(),
        lastHealth: null,
      });

      this.options.logger?.info(
        { provider: provider.key, category: provider.capabilities().category },
        'provider initialized',
      );

      return { ready: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Registered as failed rather than omitted, so `health()` can report it and an operator can
      // see that it exists and is broken — which is much more useful than its silent absence.
      this.providers.set(provider.key, {
        provider: provider as Provider,
        status: 'failed',
        error: message,
        registeredAt: this.now(),
        lastHealth: null,
      });

      this.options.logger?.error(
        { provider: provider.key, error: message },
        'provider failed to initialize; the application will start without it',
      );

      return { ready: false, error: message };
    }
  }

  /**
   * A provider by key.
   *
   * Throws for an unknown or failed one, with the initialization error attached. A caller getting
   * "the mail provider is not available: SMTP host unreachable" can act; one getting `undefined`
   * gets a null dereference three frames later.
   */
  get<T extends Provider = Provider>(key: string): T {
    const registered = this.providers.get(key);

    if (!registered) {
      const known = [...this.providers.keys()].sort();
      throw ApiError.internal(
        `No provider is registered under "${key}". Registered: ${known.join(', ') || '(none)'}.`,
      );
    }

    if (registered.status === 'failed') {
      throw ApiError.internal(
        `Provider "${key}" is not available: ${registered.error ?? 'it failed to initialize'}.`,
      );
    }

    return registered.provider as T;
  }

  /** The provider, or null. For a caller that has a fallback. */
  find<T extends Provider = Provider>(key: string): T | null {
    const registered = this.providers.get(key);
    if (!registered || registered.status === 'failed') return null;
    return registered.provider as T;
  }

  has(key: string): boolean {
    return this.providers.get(key)?.status === 'ready';
  }

  /**
   * Every ready provider in a category.
   *
   * For a caller that wants "any storage provider" rather than a specific one — which is what
   * substitutability is for, and the reason `category` is part of `capabilities`.
   */
  byCategory<T extends Provider = Provider>(category: string): T[] {
    return [...this.providers.values()]
      .filter(
        (registered) =>
          registered.status === 'ready' && registered.provider.capabilities().category === category,
      )
      .map((registered) => registered.provider as T);
  }

  /**
   * Calls a provider through a circuit breaker and a retry policy.
   *
   * The reason to route calls through here rather than calling the provider directly: a
   * downstream that is down should fail fast. Without a breaker, every request waits out the full
   * retry schedule against a service that is not coming back within the request's lifetime, and
   * the application's own capacity is consumed waiting.
   */
  async call<TResult>(
    key: string,
    operation: string,
    run: (provider: Provider) => Promise<TResult>,
    options: { retry?: RetryPolicy; signal?: AbortSignal } = {},
  ): Promise<TResult> {
    const provider = this.get(key);
    const breaker = this.breakers.get(key);

    const outcome = await withRetry(async () => breaker.execute(async () => run(provider)), {
      operation: `${key}.${operation}`,
      policy: options.retry ?? RETRY_PRESETS.interactive,
      signal: options.signal,
      onRetry: (attempt) => {
        this.options.metrics?.increment(ADAPTER_METRICS.CALL_RETRIED, 1, {
          provider: key,
          operation,
        });
        this.options.logger?.warn(
          {
            provider: key,
            operation,
            attempt: attempt.attempt,
            error: attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
          },
          'provider call failed; retrying',
        );
      },
    });

    this.options.metrics?.increment(ADAPTER_METRICS.CALL_SUCCEEDED, 1, {
      provider: key,
      operation,
      attempts: outcome.attempts,
    });

    return outcome.value;
  }

  /** Health of every provider, ready or not. */
  async healthAll(): Promise<Array<{ key: string; health: ProviderHealth }>> {
    const results: Array<{ key: string; health: ProviderHealth }> = [];

    // Concurrently: a health endpoint that checked six providers serially would take as long as
    // the sum of their timeouts, which is exactly when it is most likely to be scraped.
    await Promise.all(
      [...this.providers.entries()].map(async ([key, registered]) => {
        if (registered.status === 'failed') {
          const health: ProviderHealth = {
            status: 'critical',
            detail: registered.error ?? 'The provider failed to initialize.',
            latencyMs: 0,
            checkedAt: this.now(),
          };
          registered.lastHealth = health;
          results.push({ key, health });
          return;
        }

        const health = await registered.provider.health();
        registered.lastHealth = health;
        results.push({ key, health });

        this.options.metrics?.gauge(
          ADAPTER_METRICS.HEALTH,
          health.status === 'healthy' ? 1 : health.status === 'warning' ? 0.5 : 0,
          { provider: key },
        );
      }),
    );

    return results.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** What `trustos doctor integrations` prints. Configuration is already redacted. */
  describe(): Array<{
    key: string;
    description: string;
    status: 'ready' | 'failed';
    error: string | null;
    capabilities: ProviderCapabilities | null;
    configuration: ProviderConfigurationView | null;
    lastHealth: ProviderHealth | null;
    circuit: string;
  }> {
    return [...this.providers.entries()]
      .map(([key, registered]) => ({
        key,
        description: registered.provider.description,
        status: registered.status,
        error: registered.error,
        // A failed provider may not be able to answer either of these, so both are attempted
        // defensively — a `describe` that threw would break the very command an operator runs to
        // find out what is wrong.
        capabilities: safely(() => registered.provider.capabilities()),
        configuration: safely(() => registered.provider.configuration()),
        lastHealth: registered.lastHealth,
        circuit: this.breakers.get(key).snapshot().state,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Shuts every provider down.
   *
   * Concurrent, and no failure stops the others: `Provider.shutdown` is documented as not
   * throwing, but a registry that trusted that would let one badly-written adapter hold the whole
   * process open.
   */
  async shutdownAll(): Promise<void> {
    this.shutdownSignal.abort();

    await Promise.allSettled(
      [...this.providers.values()]
        .filter((registered) => registered.status === 'ready')
        .map((registered) => registered.provider.shutdown()),
    );

    this.providers.clear();
  }

  get size(): number {
    return this.providers.size;
  }

  keys(): string[] {
    return [...this.providers.keys()].sort();
  }
}

function safely<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

export const ADAPTER_METRICS = {
  CALL_SUCCEEDED: 'provider.call.succeeded',
  CALL_RETRIED: 'provider.call.retried',
  CALL_FAILED: 'provider.call.failed',
  /** 1 healthy, 0.5 warning, 0 critical. A gauge, so it graphs. */
  HEALTH: 'provider.health',
} as const;
