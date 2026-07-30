import { z } from 'zod';

/**
 * The model catalog.
 *
 * An application asks the registry for a model rather than naming one, and the registry is the
 * only place a model id appears. That indirection buys three things a hard-coded name cannot:
 *
 *   1. **A retirement is one edit.** Models are retired constantly. With names scattered through
 *      an application, a retirement is a search; with a registry it is a status change and a
 *      `supersededBy`.
 *   2. **Routing is possible at all.** The router picks by capability, cost and context window,
 *      and it can only do that if those facts are recorded somewhere.
 *   3. **Cost is computable.** Pricing lives here, so a token count becomes money without every
 *      caller knowing rates.
 *
 * **No model definitions ship with the framework.** Not one — no `gpt-4o`, no `claude-sonnet`.
 * Prices change monthly and availability varies by account, so a catalog baked into a framework
 * is a catalog that is wrong for most deployments and stale for the rest. The registry is the
 * shape; the entries are configuration.
 */

export const MODEL_STATUSES = [
  'available',
  /** Usable, but a replacement exists. The router avoids it unless asked explicitly. */
  'deprecated',
  /** Not usable. Kept so an old request gets an explanation rather than "unknown model". */
  'retired',
  /** Temporarily unavailable — an outage, a quota. The router routes around it. */
  'unavailable',
] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/**
 * What a model can do.
 *
 * A free-form string set rather than an enum, because capability names are a moving target and a
 * fixed enum would be wrong within a quarter. The framework defines the ones it routes on;
 * anything else is passed through and matchable.
 */
export const CAPABILITIES = {
  /** Accepts and emits text. Every model. */
  TEXT: 'text',
  /** Can be asked to call tools. */
  TOOLS: 'tools',
  /** Supports incremental streaming. */
  STREAMING: 'streaming',
  /** Will reliably emit JSON when asked. */
  JSON_MODE: 'json',
  /** Supports a schema constraint enforced by the provider. */
  JSON_SCHEMA: 'json_schema',
  /** Spends billed tokens on hidden reasoning. */
  REASONING: 'reasoning',
  /** Accepts images as input. Declared for completeness; phase 7 sends text only. */
  VISION: 'vision',
  /** Produces embeddings rather than completions. */
  EMBEDDING: 'embedding',
} as const;

export const modelPricingSchema = z
  .object({
    /**
     * Cents per million tokens. Not per token.
     *
     * Per-token prices are fractions of a cent and lose precision in floating point long before
     * a monthly total is computed. Per million keeps everything in a range where the arithmetic
     * is exact enough to reconcile against an invoice.
     */
    inputCentsPerMillion: z.number().min(0),
    outputCentsPerMillion: z.number().min(0),
    /** Reasoning tokens, when billed differently. Defaults to the output rate. */
    reasoningCentsPerMillion: z.number().min(0).optional(),
    /** Prompt tokens served from the provider's cache, usually discounted. */
    cachedInputCentsPerMillion: z.number().min(0).optional(),
    /**
     * When these prices were last confirmed.
     *
     * Recorded because a cost report computed from year-old prices is confidently wrong, and
     * `trustos ai doctor` warns when it is stale.
     */
    verifiedAt: z.coerce.date(),
  })
  .strict();

export type ModelPricing = z.infer<typeof modelPricingSchema>;

export const modelSchema = z
  .object({
    /**
     * The registry id. Stable, and the application's name for the model.
     *
     * Deliberately not required to equal the provider's id: `chat.fast` can point at whichever
     * provider model is currently fastest, and repointing it is a configuration change rather
     * than a code change.
     */
    id: z.string().min(1).max(120),

    /** The provider key: `openai`, `anthropic`, `ollama`. Matches an adapter. */
    provider: z.string().min(1).max(60),

    /** What the provider calls it. What actually goes on the wire. */
    providerModelId: z.string().min(1).max(200),

    displayName: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),

    /** The provider's version or snapshot, when it has one. */
    version: z.string().max(60).optional(),

    capabilities: z.array(z.string().min(1).max(60)).max(30),

    /**
     * Total context in tokens, input and output together.
     *
     * The router filters on it, and the gateway refuses a request that cannot fit — which is a
     * much better failure than a provider error three seconds and one billable call later.
     */
    contextTokens: z.number().int().min(1),

    /** The most it will generate in one response. Often far below the context window. */
    maxOutputTokens: z.number().int().min(1),

    /**
     * Observed p50 latency in milliseconds, for a short completion.
     *
     * A hint for routing, not a guarantee. Null when nobody has measured it, and the router
     * treats null as "unknown" rather than as "fast" — an unmeasured model should not win a
     * latency-based route by default.
     */
    p50LatencyMs: z.number().int().min(0).nullable().default(null),

    pricing: modelPricingSchema,

    status: z.enum(MODEL_STATUSES).default('available'),

    /** What to use instead. Set when deprecating, so the message says where to go. */
    supersededBy: z.string().max(120).optional(),

    /** Text and, in a later phase, others. Declared so a router can filter. */
    modalities: z.array(z.enum(['text', 'image', 'audio'])).default(['text']),

    /**
     * Restricts the model to named tenants.
     *
     * For a model under a per-tenant agreement, or one being trialled. Empty means every tenant.
     */
    allowedOrganizationIds: z.array(z.string().max(64)).max(1000).default([]),

    /** Free-form. Region, deployment name, anything an adapter needs. */
    metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  })
  .strict()
  .superRefine((model, ctx) => {
    if (model.maxOutputTokens > model.contextTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxOutputTokens'],
        message:
          'A model cannot generate more tokens than its context window holds. One of these two ' +
          'numbers was copied from the wrong row of the provider’s table.',
      });
    }

    if (model.status === 'deprecated' && !model.supersededBy) {
      // "Deprecated" with no replacement tells somebody they have a problem and not what to do.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersededBy'],
        message: 'A deprecated model must name its replacement.',
      });
    }
  });

export type Model = z.infer<typeof modelSchema>;

/**
 * The cost of a completion, in cents.
 *
 * Returned as a float in cents rather than as an integer of the smallest unit, because token
 * costs are genuinely sub-cent and rounding each call would accumulate error in the direction of
 * whoever rounds. Rounding happens once, at the point money is reported.
 */
export function computeCost(
  model: Model,
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    cachedPromptTokens?: number;
  },
): number {
  const pricing = model.pricing;
  const cached = usage.cachedPromptTokens ?? 0;

  // Cached prompt tokens are billed at their own rate when the provider has one, and are *not*
  // also billed at the full input rate — double-counting them is the most common way an AI cost
  // report comes out higher than the invoice.
  const uncachedPrompt = Math.max(0, usage.promptTokens - cached);

  const inputCost = (uncachedPrompt / 1_000_000) * pricing.inputCentsPerMillion;
  const cachedCost =
    (cached / 1_000_000) * (pricing.cachedInputCentsPerMillion ?? pricing.inputCentsPerMillion);
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputCentsPerMillion;
  const reasoningCost =
    ((usage.reasoningTokens ?? 0) / 1_000_000) *
    (pricing.reasoningCentsPerMillion ?? pricing.outputCentsPerMillion);

  return inputCost + cachedCost + outputCost + reasoningCost;
}

/** Whether a model is usable right now. `deprecated` still is — it just should not be chosen. */
export function isUsable(model: Model): boolean {
  return model.status === 'available' || model.status === 'deprecated';
}

/** Whether a tenant may use a model at all, before policy is consulted. */
export function isVisibleTo(model: Model, organizationId: string | null): boolean {
  if (model.allowedOrganizationIds.length === 0) return true;
  if (organizationId === null) return false;
  return model.allowedOrganizationIds.includes(organizationId);
}

/** How stale the pricing is, in days. `trustos ai doctor` reports it. */
export function pricingAgeDays(model: Model, now: Date = new Date()): number {
  return Math.floor((now.getTime() - model.pricing.verifiedAt.getTime()) / 86_400_000);
}
