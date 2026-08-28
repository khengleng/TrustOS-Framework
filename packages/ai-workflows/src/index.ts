/**
 * @trustos/ai-workflows
 *
 * The seam between phase 5's workflows, phase 6's events and phase 7's AI.
 *
 * An AI step has three outcomes rather than two: completed, failed, and *awaiting review* — which
 * suspends rather than blocks, so a step waiting on a person survives a deploy.
 */
export * from './steps';
