/**
 * @trustos/ai-gateway
 *
 * The single path to a provider: validation, policy, routing, context fitting, budget, guardrails,
 * cache, retry, fallback, cost and audit.
 *
 * Applications never call a provider directly. A direct call has no tenant policy, no budget, no
 * cost record, no guardrail, no audit entry and no fallback — it works perfectly in development
 * and is unauditable in production.
 *
 * The framework ships **no adapter that calls a real provider**. `AiProviderAdapter` is the
 * contract and `EchoAdapter` is a test double; a deployment brings the rest.
 */
export * from './gateway';
export * from './metrics';
export * from './provider';
