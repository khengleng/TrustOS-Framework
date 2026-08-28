import { z } from 'zod';
import { messageSchema, type FinishReason, type Message, type ToolCall } from './messages';

/**
 * The request and result shapes.
 *
 * One request type for every provider. The fields are the intersection of what is universally
 * meaningful, plus a `providerOptions` escape hatch — because an intersection with no escape
 * hatch eventually forces somebody to bypass the gateway entirely, which is the one outcome the
 * gateway exists to prevent.
 *
 * What is deliberately *not* here: a model name. A request carries a **requirement**, and the
 * router chooses. See `model-router` for why: an application that hard-codes `gpt-4o` is an
 * application that has to be edited when that model is retired, and models are retired often.
 */

/** Where an application asks for a specific model rather than describing what it needs. */
export const modelSelectionSchema = z.union([
  /** A registry model id. Checked against the registry; an unknown id is refused. */
  z.object({ kind: z.literal('model'), modelId: z.string().min(1).max(120) }).strict(),
  /**
   * A requirement. The normal case.
   *
   * The router picks by capability, cost, latency and tenant policy, and can fall back when the
   * first choice is unavailable — which an application naming a model cannot do.
   */
  z
    .object({
      kind: z.literal('requirement'),
      /** A named routing profile: `fast`, `balanced`, `deep`. Defined by the router. */
      profile: z.string().min(1).max(60).optional(),
      capabilities: z.array(z.string().max(60)).max(20).default([]),
      /** Minimum context window in tokens. The router filters on it. */
      minContextTokens: z.number().int().min(0).optional(),
      /** Ceiling on cost per million input tokens, in cents. */
      maxInputCostPerMillion: z.number().min(0).optional(),
      preferredProvider: z.string().max(60).optional(),
    })
    .strict(),
]);

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * How the caller wants the output shaped.
 *
 *   * `text`        — prose.
 *   * `json`        — valid JSON, shape unconstrained.
 *   * `json_schema` — valid JSON matching a schema. The gateway validates the result, so a
 *                     caller does not get a "successful" response that does not match.
 */
export const responseFormatSchema = z.union([
  z.object({ kind: z.literal('text') }).strict(),
  z.object({ kind: z.literal('json') }).strict(),
  z
    .object({
      kind: z.literal('json_schema'),
      name: z.string().min(1).max(120),
      /** JSON Schema. Passed to providers that support it, and validated locally regardless. */
      schema: z.record(z.unknown()),
      /**
       * Whether a mismatch is an error.
       *
       * True by default. A caller that asked for a schema and got something else has a failure,
       * and returning it as a success moves the error to wherever the object is used.
       */
      strict: z.boolean().default(true),
    })
    .strict(),
]);

export type ResponseFormat = z.infer<typeof responseFormatSchema>;

/** A tool the model may call, in the provider-neutral shape. */
export const toolDefinitionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        'A tool name is letters, digits, underscore and hyphen. Providers reject anything else.',
      ),
    description: z.string().min(1).max(1024),
    /** JSON Schema for the arguments. */
    parameters: z.record(z.unknown()),
  })
  .strict();

export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;

export const TOOL_CHOICES = ['auto', 'none', 'required'] as const;

export const completionRequestSchema = z
  .object({
    messages: z.array(messageSchema).min(1).max(1000),
    model: modelSelectionSchema,

    /**
     * 0 to 2. Absent means the model's default.
     *
     * Not defaulted to a number here, deliberately: a framework default of 0.7 would silently
     * override a provider default that may be better tuned, and would make every request look
     * like the caller had an opinion when they did not.
     */
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),

    /**
     * Ceiling on generated tokens.
     *
     * Required, and that is a deliberate departure from every provider's API, all of which make
     * it optional. An unbounded generation is an unbounded bill and an unbounded latency, and the
     * caller is the only one who knows what "enough" is.
     */
    maxOutputTokens: z.number().int().min(1).max(200_000),

    stop: z.array(z.string().min(1).max(200)).max(8).optional(),
    responseFormat: responseFormatSchema.optional(),
    tools: z.array(toolDefinitionSchema).max(128).optional(),
    toolChoice: z.enum(TOOL_CHOICES).optional(),

    /**
     * Makes an identical request return an identical *cached* result.
     *
     * Not a provider seed. This is the gateway's cache key, and it is opt-in because caching an
     * AI response is only correct when the caller says the result is reusable — see `ai-cache`
     * for why a default-on cache is a data-leak shape.
     */
    cacheKey: z.string().max(200).optional(),

    /**
     * Provider-specific options, passed through untouched.
     *
     * The escape hatch. An intersection with no escape hatch forces somebody to bypass the
     * gateway, and a bypassed gateway means no policy, no cost accounting and no audit. Adapters
     * ignore keys they do not recognise rather than failing, because a request written for one
     * provider must still run on another.
     */
    providerOptions: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.toolChoice && !request.tools?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolChoice'],
        message: 'toolChoice was set but no tools were supplied, so there is nothing to choose.',
      });
    }

    const names = (request.tools ?? []).map((tool) => tool.name);
    if (new Set(names).size !== names.length) {
      // Providers resolve a duplicate silently and unpredictably, so which implementation runs
      // becomes a function of ordering.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tools'],
        message: 'Two tools share a name. Which one the model calls would be undefined.',
      });
    }
  });

export type CompletionRequest = z.infer<typeof completionRequestSchema>;

/**
 * What a request cost, in tokens.
 *
 * `reasoningTokens` is separate because reasoning models bill for tokens that never appear in the
 * output — folding them into completion tokens makes the cost look inexplicable relative to the
 * text you can see.
 */
export const usageSchema = z
  .object({
    promptTokens: z.number().int().min(0),
    completionTokens: z.number().int().min(0),
    /** Billed but not returned. Zero for models without it. */
    reasoningTokens: z.number().int().min(0).default(0),
    /** Prompt tokens served from the provider's own cache, usually at a discount. */
    cachedPromptTokens: z.number().int().min(0).default(0),
    totalTokens: z.number().int().min(0),
    /**
     * Whether these are the provider's numbers or our estimate.
     *
     * Estimates are unavoidable — streaming responses often omit usage, and a cache hit has no
     * provider call at all — but a cost report that cannot distinguish measured from estimated is
     * a cost report nobody can reconcile against an invoice.
     */
    estimated: z.boolean().default(false),
  })
  .strict();

export type Usage = z.infer<typeof usageSchema>;

export interface CompletionResult {
  /** Framework-assigned. Correlates the gateway record, the cost entry and the audit entry. */
  id: string;
  /** The model actually used, which may not be the one first chosen — see fallback. */
  modelId: string;
  provider: string;

  content: string | null;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;

  /** Parsed and validated when `responseFormat` asked for a schema. */
  parsed?: unknown;

  /** Wall-clock milliseconds, including retries and the provider's own latency. */
  latencyMs: number;
  /** Total cost in cents. Computed from usage and registry pricing. */
  costCents: number;

  /** True when the answer came from the cache and no provider was called. */
  cached: boolean;
  /** Attempts, including the first. Greater than one means something failed and was retried. */
  attempts: number;
  /** Set when the first-choice model was unavailable and the router fell back. */
  fallbackFrom?: string;

  createdAt: Date;
}

/** One chunk of a streamed response. */
export type CompletionChunk =
  | { kind: 'content'; delta: string }
  /** Tool calls arrive fragmented; `index` identifies which call a fragment belongs to. */
  | { kind: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { kind: 'finish'; reason: FinishReason; usage?: Usage }
  | { kind: 'error'; message: string };

/**
 * Who and what a request is for.
 *
 * Every gateway call carries one. `organizationId` is the tenant boundary, and it is not optional
 * — a request with no tenant cannot be scoped, budgeted, policy-checked or audited, which is four
 * separate reasons it must not reach a provider.
 */
export interface AiRequestContext {
  organizationId: string | null;
  actorId: string | null;
  actorType: 'user' | 'service_account' | 'api_key' | 'system';
  /** Which application. Used for per-application cost attribution. */
  application: string;
  /** Ties this call to the request or workflow that caused it. */
  correlationId?: string;
  requestId?: string;
  /** The agent, when the call is on an agent's behalf. */
  agentId?: string;
  /** The prompt registry entry, when the messages came from one. */
  promptId?: string;
  promptVersion?: string;
  signal?: AbortSignal;
}

/** Builds a completion request with the fields most callers forget. */
export function buildCompletionRequest(
  input: Omit<CompletionRequest, 'messages'> & { messages: Message[] },
): CompletionRequest {
  return completionRequestSchema.parse(input);
}
