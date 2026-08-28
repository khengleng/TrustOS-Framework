/**
 * @trustos/tool-execution
 *
 * The tool registry and executor: permissions, timeouts, audit and concurrency.
 *
 * A tool call is a privileged action taken on the strength of a model's judgement, and is checked
 * accordingly. The permission checked is the **actor's**, not the agent's — which is what makes a
 * successful prompt injection survivable.
 */
export * from './executor';
