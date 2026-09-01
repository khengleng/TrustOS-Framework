import { z } from 'zod';
import type { LoggerPort } from '@trustsystem/logging';
import { AiError, type ModelSelection } from '@trustsystem/ai-sdk';
import { type Model, type ModelRegistry } from '@trustsystem/model-registry';
import type { AiPolicyEngine } from '@trustsystem/ai-policy';

/**
 * Model routing.
 *
 * An application says what it needs; the router says which model provides it. That indirection is
 * the whole reason applications do not name models:
 *
 *   * A model retirement is a registry change, not a search through application code.
 *   * A provider outage routes around itself, because there is a fallback chain.
 *   * A tenant on a data-residency agreement gets a different model for the same request, with no
 *     branch in the application.
 *
 * Routing is **deterministic**. Given the same registry state, the same requirement and the same
 * policy, it picks the same model every time. That is worth more than a marginally better choice:
 * a router that picks differently between two pods turns a bug into one that reproduces on one
 * request in three, and there is no worse shape of bug to debug.
 */

/**
 * A named routing profile.
 *
 * The vocabulary an application actually thinks in. "Fast" and "deep" are decisions somebody made
 * once, in configuration, rather than in every call site.
 */
export const routingProfileSchema = z
  .object({
    name: z.string().min(1).max(60),
    description: z.string().max(300).default(''),

    /** Every one of these is required of a candidate. */
    capabilities: z.array(z.string().max(60)).max(20).default([]),
    minContextTokens: z.number().int().min(0).default(0),
    maxInputCostPerMillion: z.number().min(0).nullable().default(null),

    /**
     * What to optimise for once the candidates are filtered.
     *
     *   * `cost`    — cheapest input price. For bulk classification.
     *   * `latency` — lowest measured p50. For anything a person is waiting on.
     *   * `context` — largest window. For long documents.
     *   * `order`   — the order given in `preferredModels`. For a deliberate ranking.
     */
    optimise: z.enum(['cost', 'latency', 'context', 'order']).default('cost'),

    /**
     * An explicit ranking, tried in order.
     *
     * The most useful field in practice: a deployment usually knows which model it wants and
     * which two to fall back to, and expressing that directly beats any scoring function.
     */
    preferredModels: z.array(z.string().max(120)).max(20).default([]),

    /**
     * How many models to try before giving up.
     *
     * Three. Enough to survive one provider outage and a second model being slow; small enough
     * that a request does not spend thirty seconds discovering everything is down.
     */
    maxCandidates: z.number().int().min(1).max(10).default(3),
  })
  .strict();

export type RoutingProfile = z.infer<typeof routingProfileSchema>;

export interface RouteDecision {
  /** The model to use. */
  model: Model;
  /** Models to try if it fails, in order. */
  fallbacks: Model[];
  /** Which profile decided, and on what basis. */
  profile: string;
  reason: string;
  /** Candidates considered, for the audit record and for debugging a surprising choice. */
  consideredIds: string[];
}

export interface ModelRouterOptions {
  registry: ModelRegistry;
  policy?: AiPolicyEngine;
  profiles?: unknown[];
  logger?: LoggerPort;
}

export interface RouteInput {
  selection: ModelSelection;
  organizationId: string | null;
  agentId?: string;
  /** Restricts to models the agent declares. Applied on top of policy. */
  allowedModels?: string[];
  /** The prompt's estimated size, so a model that cannot hold it is not chosen. */
  requiredContextTokens?: number;
  /** Streaming, tools, JSON schema — whatever this particular request needs. */
  requiredCapabilities?: string[];
}

export class ModelRouter {
  private readonly profiles = new Map<string, RoutingProfile>();

  constructor(private readonly options: ModelRouterOptions) {
    for (const profile of options.profiles ?? []) {
      const parsed = routingProfileSchema.parse(profile);
      this.profiles.set(parsed.name, parsed);
    }

    /*
     * Three defaults, so an application has a vocabulary before anybody configures one.
     *
     * They optimise on cost and context rather than naming models, because the framework ships no
     * model definitions — a default profile that named one would be a default that never matches.
     */
    if (!this.profiles.has('balanced')) {
      this.profiles.set(
        'balanced',
        routingProfileSchema.parse({
          name: 'balanced',
          description: 'The cheapest model that can do the job.',
          optimise: 'cost',
        }),
      );
    }
    if (!this.profiles.has('fast')) {
      this.profiles.set(
        'fast',
        routingProfileSchema.parse({
          name: 'fast',
          description: 'Lowest measured latency. For anything a person is waiting on.',
          optimise: 'latency',
        }),
      );
    }
    if (!this.profiles.has('deep')) {
      this.profiles.set(
        'deep',
        routingProfileSchema.parse({
          name: 'deep',
          description: 'The largest context window available.',
          optimise: 'context',
        }),
      );
    }
  }

  /**
   * Chooses a model.
   *
   * Throws when nothing qualifies, and the message says *why* nothing qualified — which of the
   * filters removed the last candidate. "No model available" with no detail is the least
   * actionable error in this whole platform.
   */
  route(input: RouteInput): RouteDecision {
    if (input.selection.kind === 'model') {
      return this.routeExplicit(input, input.selection.modelId);
    }

    // Narrowed once, so every use below is on the requirement branch rather than re-checking.
    const requirement = input.selection;
    const profile = this.profileFor(requirement.profile);

    const capabilities = [
      ...new Set([
        ...profile.capabilities,
        ...requirement.capabilities,
        ...(input.requiredCapabilities ?? []),
      ]),
    ];

    const minContext = Math.max(
      profile.minContextTokens,
      requirement.minContextTokens ?? 0,
      input.requiredContextTokens ?? 0,
    );

    const maxCost =
      requirement.maxInputCostPerMillion ?? profile.maxInputCostPerMillion ?? undefined;

    // Every registered model visible to the tenant, before any filtering. Kept so the error can
    // say which filter emptied the list.
    const all = this.options.registry.list({ organizationId: input.organizationId });

    let candidates = all.filter((model) => this.options.registry.isAvailableNow(model.id));
    const afterAvailability = candidates.length;

    candidates = candidates.filter((model) =>
      capabilities.every((capability) => model.capabilities.includes(capability)),
    );
    const afterCapabilities = candidates.length;

    candidates = candidates.filter((model) => model.contextTokens >= minContext);
    const afterContext = candidates.length;

    if (maxCost !== undefined) {
      candidates = candidates.filter((model) => model.pricing.inputCentsPerMillion <= maxCost);
    }
    const afterCost = candidates.length;

    candidates = this.applyPolicy(candidates, input);
    const afterPolicy = candidates.length;

    if (input.allowedModels?.length) {
      candidates = candidates.filter((model) => input.allowedModels!.includes(model.id));
    }

    if (requirement.preferredProvider) {
      const preferred = candidates.filter(
        (model) => model.provider === requirement.preferredProvider,
      );
      // A preference, not a filter: if the preferred provider has nothing left, the others still
      // run. A preference that emptied the candidate list would be a filter wearing a softer name.
      if (preferred.length > 0) candidates = preferred;
    }

    if (candidates.length === 0) {
      throw AiError.noModelAvailable(
        this.explainEmpty({
          all: all.length,
          afterAvailability,
          afterCapabilities,
          afterContext,
          afterCost,
          afterPolicy,
          capabilities,
          minContext,
          maxCost,
        }),
        { profile: profile.name },
      );
    }

    const ranked = this.rank(candidates, profile);
    const chosen = ranked[0]!;

    return {
      model: chosen,
      fallbacks: ranked.slice(1, profile.maxCandidates),
      profile: profile.name,
      reason: this.explainChoice(chosen, profile, ranked.length),
      consideredIds: ranked.map((model) => model.id),
    };
  }

  /** An explicitly named model. Still policy-checked — naming one is not a way around policy. */
  private routeExplicit(input: RouteInput, modelId: string): RouteDecision {
    const model = this.options.registry.get(modelId, input.organizationId);

    const permitted = this.applyPolicy([model], input);
    if (permitted.length === 0) {
      throw AiError.policyDenied(
        `The model "${modelId}" is not permitted for this tenant. Naming a model explicitly does ` +
          'not bypass policy.',
        { modelId },
      );
    }

    if (!this.options.registry.isAvailableNow(modelId)) {
      throw AiError.noModelAvailable(
        `The model "${modelId}" is currently unavailable. Ask for a requirement rather than a ` +
          'model, and the router will fall back on your behalf.',
        { modelId },
      );
    }

    return {
      model,
      // No fallback for an explicit choice: the caller asked for this model specifically, and
      // silently substituting another would produce output from a model they did not choose.
      fallbacks: [],
      profile: 'explicit',
      reason: `The caller named "${modelId}" explicitly.`,
      consideredIds: [modelId],
    };
  }

  private applyPolicy(candidates: Model[], input: RouteInput): Model[] {
    if (!this.options.policy) return candidates;

    return candidates.filter((model) => {
      const result = this.options.policy!.check({
        context: { organizationId: input.organizationId, agentId: input.agentId },
        modelId: model.id,
        provider: model.provider,
      });
      return result.allowed;
    });
  }

  /**
   * Orders the candidates.
   *
   * Every comparison falls back to model id, which is what makes routing deterministic: two
   * models with identical cost must not be ordered by whatever the array happened to hold.
   */
  private rank(candidates: Model[], profile: RoutingProfile): Model[] {
    if (profile.optimise === 'order' && profile.preferredModels.length > 0) {
      const rank = new Map(profile.preferredModels.map((id, index) => [id, index]));
      return [...candidates].sort(
        (a, b) =>
          (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
      );
    }

    // A preferred model wins its category even when not optimising on order, because somebody
    // naming it in configuration is a stronger signal than a two-cent price difference.
    const preferred = new Map(profile.preferredModels.map((id, index) => [id, index]));

    return [...candidates].sort((a, b) => {
      const aPreferred = preferred.get(a.id);
      const bPreferred = preferred.get(b.id);
      if (aPreferred !== undefined || bPreferred !== undefined) {
        return (
          (aPreferred ?? Number.MAX_SAFE_INTEGER) - (bPreferred ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id)
        );
      }

      switch (profile.optimise) {
        case 'cost':
          return (
            a.pricing.inputCentsPerMillion - b.pricing.inputCentsPerMillion ||
            a.id.localeCompare(b.id)
          );
        case 'latency': {
          /*
           * An unmeasured model does not win a latency route.
           *
           * Treating null as zero would make every newly-added model the fastest thing in the
           * catalogue, which is exactly backwards.
           */
          const aLatency = a.p50LatencyMs ?? Number.MAX_SAFE_INTEGER;
          const bLatency = b.p50LatencyMs ?? Number.MAX_SAFE_INTEGER;
          return aLatency - bLatency || a.id.localeCompare(b.id);
        }
        case 'context':
          return b.contextTokens - a.contextTokens || a.id.localeCompare(b.id);
        default:
          return a.id.localeCompare(b.id);
      }
    });
  }

  private explainChoice(model: Model, profile: RoutingProfile, considered: number): string {
    const basis =
      profile.optimise === 'cost'
        ? `cheapest input price (${model.pricing.inputCentsPerMillion}c/M)`
        : profile.optimise === 'latency'
          ? model.p50LatencyMs === null
            ? 'no measured latency on any candidate'
            : `lowest measured latency (${model.p50LatencyMs}ms)`
          : profile.optimise === 'context'
            ? `largest context window (${model.contextTokens} tokens)`
            : 'the configured preference order';

    return `Chose ${model.id} from ${considered} candidate(s) on the "${profile.name}" profile: ${basis}.`;
  }

  /**
   * Says which filter emptied the candidate list.
   *
   * "No model available" with no detail is the least actionable error in the platform. This walks
   * the filters in order and names the first one that removed everything, which is almost always
   * the one that is wrong.
   */
  private explainEmpty(state: {
    all: number;
    afterAvailability: number;
    afterCapabilities: number;
    afterContext: number;
    afterCost: number;
    afterPolicy: number;
    capabilities: string[];
    minContext: number;
    maxCost: number | undefined;
  }): string {
    if (state.all === 0) {
      return 'no models are registered for this tenant at all. The framework ships none — a deployment supplies its catalogue.';
    }
    if (state.afterAvailability === 0) {
      return `all ${state.all} registered model(s) are currently marked unavailable. A provider outage will clear on its own; a configured status will not.`;
    }
    if (state.afterCapabilities === 0) {
      return `no model has every required capability (${state.capabilities.join(', ')}). ${state.afterAvailability} were available before this filter.`;
    }
    if (state.afterContext === 0) {
      return `no model has a context window of at least ${state.minContext} tokens. The prompt needs to be shorter, or a larger model registered.`;
    }
    if (state.afterCost === 0) {
      return `no model costs ${state.maxCost}c per million input tokens or less. Raise the ceiling or register a cheaper model.`;
    }
    if (state.afterPolicy === 0) {
      return 'every otherwise-suitable model is denied by the tenant’s AI policy.';
    }
    return 'the agent’s allowed-model list excludes every remaining candidate.';
  }

  private profileFor(name: string | undefined): RoutingProfile {
    if (!name) return this.profiles.get('balanced')!;

    const profile = this.profiles.get(name);
    if (profile) return profile;

    this.options.logger?.warn(
      { profile: name, available: [...this.profiles.keys()] },
      'unknown routing profile; falling back to balanced',
    );

    return this.profiles.get('balanced')!;
  }

  profileNames(): string[] {
    return [...this.profiles.keys()].sort();
  }

  /** For `trustos ai doctor`: which model each profile would currently pick. */
  describe(organizationId: string | null = null): Array<{
    profile: string;
    description: string;
    wouldChoose: string | null;
    fallbacks: string[];
    problem: string | null;
  }> {
    return [...this.profiles.values()]
      .map((profile) => {
        try {
          const decision = this.route({
            selection: { kind: 'requirement', profile: profile.name, capabilities: [] },
            organizationId,
          });

          return {
            profile: profile.name,
            description: profile.description,
            wouldChoose: decision.model.id,
            fallbacks: decision.fallbacks.map((model) => model.id),
            problem: null,
          };
        } catch (error) {
          return {
            profile: profile.name,
            description: profile.description,
            wouldChoose: null,
            fallbacks: [],
            problem: error instanceof Error ? error.message : String(error),
          };
        }
      })
      .sort((a, b) => a.profile.localeCompare(b.profile));
  }
}
