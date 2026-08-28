/**
 * @trustos/documentation-center
 *
 * Generates module, API, CLI and dependency documentation, plus the changelog.
 *
 * The rule it enforces: anything derivable from the code is generated, and anything not derivable
 * is hand-written. Mixing them produces documentation that is partially stale, and a reader who
 * finds one stale section stops trusting the accurate ones. Why a thing is designed the way it is
 * stays in hand-written prose, because a generator cannot produce a reason.
 *
 * Everything returns strings and nothing is written to disk, so one function serves `trustos docs`,
 * the developer portal, and a test that asserts the output.
 */
export * from './generate';
