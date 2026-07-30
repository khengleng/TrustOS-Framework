/**
 * @trustos/module-agent
 *
 * Agents that take actions: declarative agent definitions, the tool loop with per-actor permission checks, memory, conversation state, stop conditions and human review.
 *
 * The implementation lives in `@trustos/agent-framework`, `@trustos/agent-memory`, `@trustos/agent-runtime`, `@trustos/conversation`, `@trustos/function-calling`, `@trustos/human-review`, `@trustos/tool-execution`; this
 * package is the module contract around it.
 */
export * from './agent.module';
