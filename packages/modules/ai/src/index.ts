/**
 * @trustsystem/module-ai
 *
 * The AI gateway and everything a model call has to pass through: model registry, prompt registry, guardrails, tenant policy, routing, cost accounting and caching.
 *
 * The implementation lives in `@trustsystem/ai-cache`, `@trustsystem/ai-gateway`, `@trustsystem/ai-observability`, `@trustsystem/ai-policy`, `@trustsystem/ai-sdk`, `@trustsystem/content-filter`, `@trustsystem/cost-monitor`, `@trustsystem/guardrails`, `@trustsystem/model-registry`, `@trustsystem/model-router`, `@trustsystem/prompt-registry`, `@trustsystem/prompt-security`, `@trustsystem/token-meter`; this
 * package is the module contract around it.
 */
export * from './ai.module';
