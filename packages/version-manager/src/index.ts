/**
 * @trustos/version-manager
 *
 * Semantic versioning, ranges, the compatibility matrix, version history and upgrade
 * recommendations. The package everything else in Phase 10 asks "may these run together" and
 * "what should this move to".
 *
 * Two ideas run through it.
 *
 * **Untested is a third answer.** A compatibility matrix records what was verified; an unrecorded
 * pairing is `unknown`, never `compatible`. A rule that says "any framework at or above the
 * minimum works" is right until the framework removes something, and then it is silently wrong
 * for every module ever published.
 *
 * **Below 1.0.0 the minor is the breaking position.** Treating `0.x` as "anything goes" is how a
 * framework at 0.9 breaks every application on a patch release and calls itself compliant.
 */
export * from './semver';
export * from './compatibility-matrix';
export * from './history';
