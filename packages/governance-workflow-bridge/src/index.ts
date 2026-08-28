/**
 * @trustos/governance-workflow-bridge
 *
 * The approval and case **experience**. TrustOS Workflow remains authoritative for the state.
 *
 * The concrete consequence: the frontend never holds approval state. Every view carries the
 * engine's version and every decision submits it back, so a screen that has gone stale is refused
 * rather than submitted and hoped for — which is what produces a retry, and then a force flag.
 *
 * Self-approval is refused here as well as in the engine. Not redundancy: the engine's refusal is
 * the control, and this one is the affordance. A button refused after being pressed teaches
 * somebody to press it.
 */
export * from './bridge';
