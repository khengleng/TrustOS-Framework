/**
 * @trustsystem/module-agent
 *
 * Agents that take actions: declarative agent definitions, the tool loop with per-actor permission checks, memory, conversation state, stop conditions and human review.
 *
 * The implementation lives in `@trustsystem/agent-framework`, `@trustsystem/agent-memory`, `@trustsystem/agent-runtime`, `@trustsystem/conversation`, `@trustsystem/function-calling`, `@trustsystem/human-review`, `@trustsystem/tool-execution`; this
 * package is the module contract around it.
 */
export * from './agent.module';
