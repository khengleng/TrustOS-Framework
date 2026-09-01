/**
 * @trustsystem/policy-evaluator
 *
 * Deterministic evaluation: no clock, no I/O, no randomness. The same policy version and the same
 * attributes give the same decision on any machine in any year — which is what makes a decision
 * log worth keeping, because a logged decision can be **re-derived** rather than believed.
 *
 * `missingAttributes` is the field to understand before using a result. A rule reading an
 * attribute the caller did not supply **does not match** — absent is not false — so a caller who
 * forgets `amount` gets a policy that has silently stopped enforcing its amount threshold. The
 * field exists so that "silently" is a choice rather than a default.
 *
 * An obligation the caller does not understand is a **denial**. Otherwise a caller ignoring an
 * unknown obligation converts a conditional permission into an unconditional one.
 */
export * from './evaluate';
