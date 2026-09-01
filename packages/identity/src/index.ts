/**
 * @trustsystem/identity
 *
 * Provider-neutral identity. Application code consumes this and never a provider
 * SDK, so swapping local authentication for Keycloak is a configuration change and
 * a different implementation of one interface.
 *
 * Read `provider.ts` first for the contract, then `oidc/oidc-provider.ts` for the
 * four validations that make token verification meaningful — signature, issuer,
 * audience, algorithm — and why none of them is optional.
 */
export * from './provider';
export * from './authenticators';
export * from './bearer-authenticator';
export * from './local/password';
export * from './local/lockout';
export * from './local/local-provider';
export * from './oidc/oidc-provider';
export * from './oidc/pkce';
