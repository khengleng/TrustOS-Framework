/**
 * @trustsystem/api-versioning
 *
 * What changed between two versions, what bump it requires, and what a breaking change owes its
 * consumers.
 *
 * The failure this prevents is not the obviously breaking change — that one gets a major version.
 * It is the nearly-compatible one that ships as a patch: a removed optional field, a tightened
 * validation, a newly required scope.
 */
export * from './versioning';
