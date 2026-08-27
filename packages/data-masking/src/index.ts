/**
 * @trustos/data-masking
 *
 * Platform-wide masking, tokenization and pseudonymization.
 *
 * The display strategies and the reveal ceremony are `@trustos/governance-pii-policy`'s and are
 * **reused rather than restated** — a second `mask()` here would be a second set of rules about
 * how many digits of an account number a person sees, and the two would diverge.
 *
 * What this adds is about data rather than a screen: a tokenization **port** (the framework ships
 * no vault — it holds the surrogate-to-value mapping, which makes it the most sensitive store in
 * the platform), keyed pseudonymization (an unsalted hash of a phone number is reversible by
 * anybody with a list of phone numbers), and masking rules **derived from the classification** so
 * a reclassification changes what people see.
 */
export * from './masking';
