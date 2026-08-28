/**
 * @trustos/module-ai
 *
 * The AI gateway and everything a model call has to pass through: model registry, prompt registry, guardrails, tenant policy, routing, cost accounting and caching.
 *
 * The implementation lives in `@trustos/ai-cache`, `@trustos/ai-gateway`, `@trustos/ai-observability`, `@trustos/ai-policy`, `@trustos/ai-sdk`, `@trustos/content-filter`, `@trustos/cost-monitor`, `@trustos/guardrails`, `@trustos/model-registry`, `@trustos/model-router`, `@trustos/prompt-registry`, `@trustos/prompt-security`, `@trustos/token-meter`; this
 * package is the module contract around it.
 */
export * from './ai.module';
