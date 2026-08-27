/**
 * @trustos/policy-engine
 *
 * The centralized decision point: registry, evaluator and decision log, defaulting to deny and
 * recording everything.
 *
 * Two policy systems in one platform is usually a mistake, so the split is explicit.
 * `@trustos/authorization` decides **who may call what** — code policies, part of the platform's
 * structure, changed with a release. This decides **what the rules currently are** — documents a
 * deployment changes without a release, versioned, approved, and logged so a decision can be
 * re-derived.
 *
 * They compose through `asAuthorizationPolicy`, which can only **refuse**. A document policy that
 * could grant would be a way to widen access by editing configuration.
 */
export * from './engine';
