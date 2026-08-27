/**
 * @trustos/governance-tool-runtime
 *
 * Executes an internal application definition: seven steps, in one order, documented on the class.
 *
 * The step most systems omit is the last one — **refusals are audited too**. A trail of
 * successful reads answers "what did they see" and not "what did they try", and the second is the
 * question an investigation opens with.
 *
 * The runtime produces **plans** and holds no database client and no HTTP client. A deployment's
 * executor takes a plan and runs it, which is what keeps the decision and the execution from
 * drifting: there is nothing left for the executor to decide.
 */
export * from './runtime';
