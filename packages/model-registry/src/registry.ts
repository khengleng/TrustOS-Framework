import { ApiError } from '@trustsystem/errors';
import { AiError } from '@trustsystem/ai-sdk';
import {
  isUsable,
  isVisibleTo,
  modelSchema,
  pricingAgeDays,
  type Model,
  type ModelStatus,
} from './model';

/**
 * The registry.
 *
 * Loaded at start-up from configuration. Not from a database, for the same reason the event
 * schema registry is not: a catalog loaded at runtime can differ between two instances of the
 * same application, and "which of my three pods thinks this model exists" is not a question
 * anybody should have to answer.
 *
 * Availability, by contrast, *is* mutable at runtime — a provider outage is a fact about now, not
 * about configuration. `markUnavailable` is how the gateway tells the router to route around
 * something.
 */

export interface ModelFilter {
  organizationId?: string | null;
  provider?: string;
  /** Every one of these must be present. */
  capabilities?: string[];
  minContextTokens?: number;
  maxInputCostPerMillion?: number;
  /** Defaults to usable models only. */
  includeRetired?: boolean;
  status?: ModelStatus;
}

export interface ModelRegistryOptions {
  models?: unknown[];
  now?: () => Date;
  /**
   * How long an availability override lasts.
   *
   * Fifteen minutes. Long enough to route around a real outage, short enough that a model marked
   * unavailable by a transient blip comes back on its own — a permanent override would need
   * somebody to notice and clear it, and nobody ever does.
   */
  unavailableForMs?: number;
}

export class ModelRegistry {
  private readonly models = new Map<string, Model>();
  /** Runtime availability overrides: model id → when the override expires. */
  private readonly unavailableUntil = new Map<string, number>();
  private readonly now: () => Date;
  private readonly unavailableForMs: number;

  constructor(options: ModelRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.unavailableForMs = options.unavailableForMs ?? 15 * 60_000;

    for (const model of options.models ?? []) this.register(model);
  }

  /**
   * Registers a model.
   *
   * Validation is strict and the errors name the field, because this runs at start-up from
   * configuration somebody hand-wrote — and a configuration mistake found at boot is minutes,
   * while the same mistake found at the first request is an incident.
   */
  register(input: unknown): Model {
    const parsed = modelSchema.safeParse(input);

    if (!parsed.success) {
      const id = (input as { id?: string } | null)?.id ?? '(unnamed)';
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `${id}.${issue.path.join('.')}`,
          message: issue.message,
        })),
        `The model "${id}" is not configured correctly.`,
      );
    }

    const model = parsed.data;

    if (this.models.has(model.id)) {
      throw ApiError.conflict(
        `A model is already registered as "${model.id}". Two definitions of one id would make ` +
          'which provider a request reaches depend on configuration order.',
        { reason: 'model_conflict', modelId: model.id },
      );
    }

    if (model.supersededBy && !this.models.has(model.supersededBy)) {
      /*
       * The replacement is not required to exist *yet*.
       *
       * Configuration order is arbitrary and a deprecated model is often listed before its
       * replacement. `validate()` checks the references once everything is loaded, which is the
       * only point at which the check is meaningful.
       */
    }

    this.models.set(model.id, model);
    return model;
  }

  registerAll(models: unknown[]): this {
    for (const model of models) this.register(model);
    return this;
  }

  /**
   * Checks the catalog as a whole, after everything is loaded.
   *
   * Returns problems rather than throwing: a dangling `supersededBy` should be visible in
   * `trustos ai doctor` without stopping an application from booting, because the models that
   * *are* correct still work.
   */
  validate(): string[] {
    const problems: string[] = [];

    for (const model of this.models.values()) {
      if (model.supersededBy && !this.models.has(model.supersededBy)) {
        problems.push(
          `${model.id} is superseded by "${model.supersededBy}", which is not registered. A ` +
            'caller told to move there would find nothing.',
        );
      }

      const age = pricingAgeDays(model, this.now());
      if (age > 180) {
        problems.push(
          `${model.id} has pricing last verified ${age} days ago. Cost reports computed from it ` +
            'are confidently wrong.',
        );
      }
    }

    if (this.models.size === 0) {
      problems.push(
        'No models are registered. The framework ships none deliberately — prices change monthly ' +
          'and availability varies by account — so a deployment supplies its own catalog.',
      );
    }

    return problems;
  }

  /**
   * A model by id.
   *
   * Throws for an unknown or retired one. A retired model gets its own message naming the
   * replacement, because "unknown model" for something that existed last month sends somebody
   * looking for a typo.
   */
  get(id: string, organizationId: string | null = null): Model {
    const model = this.models.get(id);

    if (!model) {
      throw AiError.modelUnknown(id, [...this.models.keys()].sort());
    }

    if (model.status === 'retired') {
      throw ApiError.validation(
        [
          {
            path: 'model',
            message:
              `The model "${id}" is retired` +
              (model.supersededBy ? `; use "${model.supersededBy}" instead.` : '.'),
            code: 'model_retired',
          },
        ],
        `"${id}" is no longer available.`,
      );
    }

    if (!isVisibleTo(model, organizationId)) {
      // Reported as unknown rather than forbidden: confirming the model exists tells a tenant
      // something about another tenant's arrangements.
      throw AiError.modelUnknown(
        id,
        this.list({ organizationId }).map((entry) => entry.id),
      );
    }

    return model;
  }

  /** The model, or null. For a caller with a fallback. */
  find(id: string, organizationId: string | null = null): Model | null {
    try {
      return this.get(id, organizationId);
    } catch {
      return null;
    }
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  /**
   * Models matching a filter.
   *
   * The router's main entry point. Ordered by id so the result is stable — an unstable ordering
   * makes routing non-deterministic between processes, which turns a routing bug into one that
   * reproduces on one pod out of three.
   */
  list(filter: ModelFilter = {}): Model[] {
    const organizationId = filter.organizationId ?? null;

    return [...this.models.values()]
      .filter((model) => (filter.includeRetired ? true : isUsable(model)))
      .filter((model) => !filter.status || model.status === filter.status)
      .filter((model) => isVisibleTo(model, organizationId))
      .filter((model) => !filter.provider || model.provider === filter.provider)
      .filter((model) =>
        (filter.capabilities ?? []).every((capability) => model.capabilities.includes(capability)),
      )
      .filter((model) => !filter.minContextTokens || model.contextTokens >= filter.minContextTokens)
      .filter(
        (model) =>
          filter.maxInputCostPerMillion === undefined ||
          model.pricing.inputCentsPerMillion <= filter.maxInputCostPerMillion,
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Marks a model unavailable for a while.
   *
   * Called by the gateway when a provider fails in a way that suggests the model itself is the
   * problem — a 404 on the model, a persistent 503. The router then routes around it without
   * anybody editing configuration.
   *
   * Time-limited on purpose: a permanent override needs somebody to notice and clear it, and
   * nobody ever does. The model comes back and, if it is still broken, gets marked again.
   */
  markUnavailable(id: string, reason: string, forMs?: number): void {
    if (!this.models.has(id)) return;
    this.unavailableUntil.set(id, this.now().getTime() + (forMs ?? this.unavailableForMs));
    void reason;
  }

  /** Clears an override, for an operator who knows the provider is back. */
  markAvailable(id: string): void {
    this.unavailableUntil.delete(id);
  }

  /**
   * Whether a model can be called right now.
   *
   * Configuration status *and* the runtime override. A model that is `available` in
   * configuration but currently failing is not available, and the router must see that.
   */
  isAvailableNow(id: string): boolean {
    const model = this.models.get(id);
    if (!model || !isUsable(model) || model.status === 'unavailable') return false;

    const until = this.unavailableUntil.get(id);
    if (until === undefined) return true;

    if (until <= this.now().getTime()) {
      // Expired. Cleared here rather than on a timer, so the map does not accumulate entries for
      // models that recovered.
      this.unavailableUntil.delete(id);
      return true;
    }

    return false;
  }

  /** Models that are usable right now. What the router actually picks from. */
  available(filter: ModelFilter = {}): Model[] {
    return this.list(filter).filter((model) => this.isAvailableNow(model.id));
  }

  /** For `trustos ai list-models` and the observability dashboard. */
  describe(organizationId: string | null = null): Array<{
    id: string;
    provider: string;
    displayName: string;
    status: ModelStatus;
    availableNow: boolean;
    contextTokens: number;
    maxOutputTokens: number;
    capabilities: string[];
    inputCentsPerMillion: number;
    outputCentsPerMillion: number;
    pricingAgeDays: number;
    supersededBy: string | null;
  }> {
    return this.list({ organizationId, includeRetired: true }).map((model) => ({
      id: model.id,
      provider: model.provider,
      displayName: model.displayName,
      status: model.status,
      availableNow: this.isAvailableNow(model.id),
      contextTokens: model.contextTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
      inputCentsPerMillion: model.pricing.inputCentsPerMillion,
      outputCentsPerMillion: model.pricing.outputCentsPerMillion,
      pricingAgeDays: pricingAgeDays(model, this.now()),
      supersededBy: model.supersededBy ?? null,
    }));
  }

  get size(): number {
    return this.models.size;
  }

  ids(): string[] {
    return [...this.models.keys()].sort();
  }

  providers(): string[] {
    return [...new Set([...this.models.values()].map((model) => model.provider))].sort();
  }
}
