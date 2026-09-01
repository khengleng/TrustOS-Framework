/**
 * @trustsystem/governance-auth-context
 *
 * Turns an authenticated enterprise identity into a TrustOS actor context.
 *
 * One job, and it is a refusal: **claims become an identity, never an authorization.**
 * `normalizeActor` returns an empty permission list, always. Permissions come from the
 * server-side membership lookup and nowhere else, and there is no code path here that reads an
 * organization or a permission out of a token.
 */
export * from './normalize';
