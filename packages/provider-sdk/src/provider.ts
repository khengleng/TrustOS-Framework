import { z } from 'zod';

/**
 * The provider contract.
 *
 * Every external system this platform talks to — a mail sender, a storage backend, an SMS
 * gateway, whatever a product adds later — implements this. Five methods, and the point of
 * fixing them is that operations can then ask the same questions of every integration:
 *
 *   * **`initialize`** — take configuration, establish whatever needs establishing, fail loudly
 *     if the configuration is wrong. At start-up, when somebody is watching, rather than at the
 *     first real request.
 *   * **`health`** — is it working *now*. Cheap enough to call every thirty seconds.
 *   * **`capabilities`** — what this implementation actually supports. Two providers behind one
 *     interface are rarely equivalent, and pretending otherwise means finding out in production.
 *   * **`configuration`** — the resolved configuration, secrets redacted. What `trustos doctor`
 *     prints.
 *   * **`shutdown`** — release connections. Without it, a graceful restart is not graceful: an
 *     open pool keeps the process alive until something kills it.
 *
 * **The framework ships no provider implementations.** Not one. This is the seam; a product
 * built on the framework brings the adapters. That is the difference between a framework and a
 * product, and the whole reason phase 6 stops here.
 */

export const PROVIDER_HEALTH = ['healthy', 'warning', 'critical', 'unknown'] as const;
export type ProviderHealthStatus = (typeof PROVIDER_HEALTH)[number];

export interface ProviderHealth {
  status: ProviderHealthStatus;
  /** One sentence, for an operator. "Reachable, p95 340ms" beats "OK". */
  detail: string;
  /** How long the check took. Often the most useful signal on its own. */
  latencyMs: number;
  checkedAt: Date;
  /** Anything provider-specific worth surfacing. Redacted before storage. */
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * What a provider can do.
 *
 * Free-form keys with a documented meaning per provider category, rather than a fixed enum:
 * the framework does not know what capabilities a future category needs, and a fixed list would
 * be wrong for the first product that adds one.
 *
 * The point is that a caller can *ask*, rather than discovering that this particular mail
 * provider cannot do attachments when a user tries to send one.
 */
export interface ProviderCapabilities {
  /** e.g. `mail`, `storage`, `sms`. Groups providers that are substitutable. */
  category: string;
  /** e.g. `{ attachments: true, templates: false, batchSize: 100 }`. */
  features: Record<string, boolean | number | string>;
  /** Human-readable notes: rate limits, quirks, anything an integrator needs to know. */
  notes?: string[];
}

export interface ProviderConfigurationView {
  /** The provider's own key, e.g. `mail.smtp`. */
  key: string;
  /** Resolved configuration with every secret replaced. Never the real values. */
  values: Record<string, unknown>;
  /** Which fields were redacted, so an operator can tell "unset" from "hidden". */
  redactedFields: string[];
}

/**
 * The contract.
 *
 * `TConfig` is the provider's own configuration type; the registry validates it against
 * `configSchema` before `initialize` is ever called, so an implementation may assume it is valid.
 */
export interface Provider<TConfig = unknown> {
  /** Unique. `category.implementation`: `mail.smtp`, `storage.s3`. */
  readonly key: string;
  /** For the admin UI and `trustos doctor integrations`. */
  readonly description: string;
  /** Validates configuration. Enforced by the registry before initialization. */
  readonly configSchema: z.ZodType<TConfig>;

  /**
   * Prepares the provider for use.
   *
   * Called once, at start-up. Should fail if the configuration cannot work — a wrong host, a
   * missing credential — because a provider that initializes happily and fails on first use moves
   * the error from deployment time to the worst possible moment.
   */
  initialize(config: TConfig, context: ProviderContext): Promise<void>;

  /**
   * Whether it is working right now.
   *
   * Must be cheap and must not throw: a health check that throws is reported as unknown, which is
   * strictly less useful than a `critical` with a reason. Should not have side effects — this
   * runs every thirty seconds, forever.
   */
  health(): Promise<ProviderHealth>;

  capabilities(): ProviderCapabilities;

  /** The resolved configuration, secrets redacted. */
  configuration(): ProviderConfigurationView;

  /**
   * Releases resources.
   *
   * Called on shutdown. Must be idempotent — it may be called twice if a shutdown races a
   * health check — and must not throw, because a provider that throws here can prevent the
   * others from shutting down at all.
   */
  shutdown(): Promise<void>;
}

export interface ProviderContext {
  /** Which application is using it. For user agents and log lines. */
  serviceName: string;
  environment: string;
  logger?: {
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
    error(payload: Record<string, unknown>, message: string): void;
  };
  /**
   * Cancelled on shutdown.
   *
   * A provider holding a long-lived connection should watch it, so a restart does not wait for a
   * socket timeout.
   */
  signal: AbortSignal;
}

/**
 * A base class that gets the boring parts right.
 *
 * Optional — implementing `Provider` directly is fine. What this provides is the behaviour that
 * is easy to get wrong and tedious to repeat: health that never throws, idempotent shutdown,
 * configuration redaction, and a clear error when a method is called before initialization.
 */
export abstract class BaseProvider<TConfig> implements Provider<TConfig> {
  abstract readonly key: string;
  abstract readonly description: string;
  abstract readonly configSchema: z.ZodType<TConfig>;

  protected config: TConfig | null = null;
  protected context: ProviderContext | null = null;
  private initialized = false;
  private shutDown = false;

  /** Field names whose values are redacted in `configuration()`. Extend in a subclass. */
  protected secretFields: string[] = [
    'password',
    'secret',
    'token',
    'key',
    'credential',
    'apiKey',
    'privateKey',
    'connectionString',
  ];

  async initialize(config: TConfig, context: ProviderContext): Promise<void> {
    this.config = config;
    this.context = context;
    await this.onInitialize(config, context);
    this.initialized = true;
    this.shutDown = false;
  }

  /** Where a subclass does its own setup. */
  protected abstract onInitialize(config: TConfig, context: ProviderContext): Promise<void>;

  /** Where a subclass implements its check. May throw; `health()` catches. */
  protected abstract checkHealth(): Promise<Omit<ProviderHealth, 'latencyMs' | 'checkedAt'>>;

  abstract capabilities(): ProviderCapabilities;

  /**
   * Wraps the subclass's check.
   *
   * Never throws, and times the call. A check that threw would be reported as `unknown`, which
   * tells an operator strictly less than `critical` with the reason attached — so the throw is
   * turned into exactly that.
   */
  async health(): Promise<ProviderHealth> {
    const startedAt = Date.now();

    if (!this.initialized) {
      return {
        status: 'critical',
        detail: 'The provider has not been initialized.',
        latencyMs: 0,
        checkedAt: new Date(),
      };
    }

    if (this.shutDown) {
      return {
        status: 'critical',
        detail: 'The provider has been shut down.',
        latencyMs: 0,
        checkedAt: new Date(),
      };
    }

    try {
      const result = await this.checkHealth();
      return { ...result, latencyMs: Date.now() - startedAt, checkedAt: new Date() };
    } catch (error) {
      return {
        status: 'critical',
        detail: `The health check failed: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date(),
      };
    }
  }

  configuration(): ProviderConfigurationView {
    const redactedFields: string[] = [];
    const values: Record<string, unknown> = {};

    for (const [field, value] of Object.entries((this.config ?? {}) as Record<string, unknown>)) {
      if (this.isSecretField(field)) {
        // The empty string is reported as unset rather than hidden — an operator debugging a
        // missing credential needs to tell those apart.
        values[field] = value === undefined || value === null || value === '' ? null : '[REDACTED]';
        if (values[field] !== null) redactedFields.push(field);
        continue;
      }
      values[field] = value;
    }

    return { key: this.key, values, redactedFields };
  }

  protected isSecretField(field: string): boolean {
    const lowered = field.toLowerCase();
    return this.secretFields.some((pattern) => lowered.includes(pattern.toLowerCase()));
  }

  async shutdown(): Promise<void> {
    // Idempotent: shutdown can race a health check, and a second call must be harmless.
    if (this.shutDown || !this.initialized) {
      this.shutDown = true;
      return;
    }

    this.shutDown = true;

    try {
      await this.onShutdown();
    } catch (error) {
      // Swallowed deliberately. A provider that throws here would stop the others from shutting
      // down, turning one misbehaving adapter into a process that will not exit.
      this.context?.logger?.error(
        {
          provider: this.key,
          error: error instanceof Error ? error.message : String(error),
        },
        'provider shutdown failed',
      );
    }
  }

  /** Where a subclass releases its resources. Default is nothing. */
  protected async onShutdown(): Promise<void> {}

  /** For a subclass method that needs configuration. Clear error rather than a null dereference. */
  protected requireConfig(): TConfig {
    if (!this.config || !this.initialized) {
      throw new Error(
        `Provider "${this.key}" was used before it was initialized. Register it with the ` +
          'ProviderRegistry, which initializes every provider at start-up.',
      );
    }
    return this.config;
  }

  get isInitialized(): boolean {
    return this.initialized && !this.shutDown;
  }
}
