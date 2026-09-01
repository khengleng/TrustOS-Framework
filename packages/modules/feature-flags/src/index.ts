/**
 * @trustsystem/module-feature-flags
 *
 * Boolean flags with percentage rollout, per-subject overrides, environment
 * scoping and expiry, over a REST API.
 *
 * Read `evaluate.ts` first: the evaluation order is fixed and every rule can only
 * turn a flag off, which is what makes a misconfigured flag fail closed.
 */
export * from './config';
export * from './evaluate';
export * from './store';
export * from './feature-flags.service';
export * from './feature-flags.module';
