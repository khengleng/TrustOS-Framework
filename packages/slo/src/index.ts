/**
 * @trustos/slo
 *
 * Objectives, error budgets and burn rates.
 *
 * An exhausted budget produces recommended actions and a stated reason. It does not stop
 * production by itself: a rule that halts deployment without a human will be disabled the first
 * time it is wrong, and after that it protects nothing.
 */
export * from './objective';
