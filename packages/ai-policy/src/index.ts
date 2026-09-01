/**
 * @trustsystem/ai-policy
 *
 * Per-tenant policy: allowed models, tools, knowledge bases, budgets, runtime and approval rules.
 *
 * Models are allowed by default and **tools are denied by default**. The asymmetry is deliberate:
 * adding a model changes what answers, while adding a tool changes what the system can do.
 */
export * from './policy';
