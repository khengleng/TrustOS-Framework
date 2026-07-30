import { ApiError } from '@trustos/errors';

/**
 * AI-specific errors.
 *
 * A thin layer over `ApiError`, because the AI layer has failure modes that HTTP status codes
 * describe badly, and a caller branching on `error.message` is a caller whose error handling
 * breaks when somebody improves the wording.
 *
 * Each carries `reason`, which is what a caller should branch on.
 */

export type AiErrorReason =
  /** The registry has no such model, or it is retired. */
  | 'model_unknown'
  /** Every candidate model was unavailable and fallback ran out. */
  | 'no_model_available'
  /** Tenant policy forbids this model, tool or knowledge base. */
  | 'policy_denied'
  /** A guardrail refused the input or the output. */
  | 'guardrail_blocked'
  /** The tenant is over budget. */
  | 'budget_exceeded'
  /** The prompt is longer than the model's context window. */
  | 'context_overflow'
  /** The provider refused with its own safety filter. */
  | 'provider_refused'
  /** The provider failed, after retries. */
  | 'provider_unavailable'
  /** The output did not match the requested schema. */
  | 'schema_mismatch'
  /** The model asked for a tool that is not registered or not permitted. */
  | 'tool_denied'
  /** The agent hit its step, token or time limit without finishing. */
  | 'agent_limit_reached'
  /** Output is awaiting human review and is not yet usable. */
  | 'review_required';

export interface AiErrorContext {
  reason: AiErrorReason;
  modelId?: string;
  provider?: string;
  agentId?: string;
  promptId?: string;
  [key: string]: unknown;
}

/**
 * The AI error factory.
 *
 * Status codes are chosen for what a caller should *do*:
 *
 *   * 400 — the caller's request is wrong and will fail again unchanged.
 *   * 403 — policy or a guardrail refused. Not retryable, and not the caller's mistake to fix.
 *   * 422 — the model produced something unusable. Retrying may work.
 *   * 429 — over budget. Retryable later, not now.
 *   * 503 — the provider is down. Retryable.
 */
export const AiError = {
  modelUnknown(modelId: string, known: string[]): ApiError {
    return ApiError.validation(
      [
        {
          path: 'model',
          message:
            `No model "${modelId}" is registered. Registered: ${known.slice(0, 10).join(', ')}` +
            `${known.length > 10 ? `, and ${known.length - 10} more` : ''}. Applications request ` +
            'models through the registry so a retirement is one edit rather than a search.',
          code: 'model_unknown',
        },
      ],
      `Unknown model "${modelId}".`,
    );
  },

  noModelAvailable(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.internal(`No model could serve this request: ${detail}`, {
      reason: 'no_model_available',
      ...context,
    });
  },

  policyDenied(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.forbidden(detail, { reason: 'policy_denied', ...context });
  },

  guardrailBlocked(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.forbidden(detail, { reason: 'guardrail_blocked', ...context });
  },

  budgetExceeded(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.rateLimited(detail, { reason: 'budget_exceeded', ...context });
  },

  /**
   * A validation error rather than a contextual one, so `context` is folded into the message.
   *
   * `ApiError.validation` carries details rather than a context object — which is right for a
   * caller-fixable problem, and means the model id has to travel in the text. Callers branch on
   * the issue `code`, not on `error.context.reason`.
   */
  contextOverflow(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    const suffix = context.modelId ? ` (model: ${context.modelId})` : '';

    return ApiError.validation(
      [{ path: 'messages', message: `${detail}${suffix}`, code: 'context_overflow' }],
      'This conversation is longer than the model can read.',
    );
  },

  providerUnavailable(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.rateLimited(detail, { reason: 'provider_unavailable', ...context });
  },

  schemaMismatch(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.internal(detail, { reason: 'schema_mismatch', ...context });
  },

  toolDenied(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.forbidden(detail, { reason: 'tool_denied', ...context });
  },

  agentLimitReached(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.internal(detail, { reason: 'agent_limit_reached', ...context });
  },

  reviewRequired(detail: string, context: Partial<AiErrorContext> = {}): ApiError {
    return ApiError.conflict(detail, { reason: 'review_required', ...context });
  },
};

/** The reason on an error, or null. For a caller branching on cause rather than message. */
export function aiErrorReason(error: unknown): AiErrorReason | null {
  if (!(error instanceof ApiError)) return null;
  const context = (error as unknown as { context?: { reason?: string } }).context;
  return (context?.reason as AiErrorReason | undefined) ?? null;
}
