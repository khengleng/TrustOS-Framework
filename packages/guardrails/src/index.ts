/**
 * @trustos/guardrails
 *
 * The safety pipeline: input checks, output validation and human-review hooks.
 *
 * It does not eliminate hallucinations, and the header of `pipeline.ts` says so at length. What
 * it offers is schema validation, which is checkable; groundedness signals, which are partial;
 * and human review, which is the only thing that reliably catches a plausible wrong answer.
 */
export * from './pipeline';
