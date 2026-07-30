/**
 * @trustos/agent-runtime
 *
 * Runs an agent: the tool loop, the stop conditions, the execution history.
 *
 * Everything difficult about running an agent is knowing when to stop, and "when the model says
 * it is done" is only one of four answers. A run that ran out of steps, tokens or time reports
 * `limit_reached` and is not a success.
 */
export * from './runtime';
