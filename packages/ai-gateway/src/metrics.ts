/** Metric names the gateway emits. Constants, so a typo is not a silently empty dashboard. */
export const AI_METRICS = {
  REQUESTS: 'ai.requests',
  LATENCY_MS: 'ai.latency_ms',
  TOKENS: 'ai.tokens',
  COST_CENTS: 'ai.cost_cents',
  RETRIES: 'ai.retries',
  FAILURES: 'ai.failures',
  /** Refused by a guardrail. Labelled by stage: input or output. */
  BLOCKED: 'ai.request.blocked',
  CACHE_HITS: 'ai.cache_hits',
  /** Output held for a person. The number that says whether review is a bottleneck. */
  REVIEW_REQUIRED: 'ai.review_required',
} as const;
