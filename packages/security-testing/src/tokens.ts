import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

/**
 * Token forgery, for tests.
 *
 * A security test suite that only checks the happy path proves that a correct token
 * is accepted, which nobody doubted. What matters is that a token which is *almost*
 * right is refused — wrong issuer, wrong audience, expired, re-signed with a key the
 * attacker controls, `alg: none`, a payload edited after signing — and every one of
 * those needs a token to be constructed on purpose.
 *
 * This package makes them one line each, so a product's own suite can assert them
 * without learning JOSE.
 */

export interface TestIdentityProviderKeys {
  privateKey: KeyLike;
  publicJwk: JWK;
  /** A JWKS resolver to hand to `OidcIdentityProvider`, so no network is used. */
  jwks: ReturnType<typeof createLocalJwks>;
  kid: string;
}

/** Generates a key pair and a matching local JWKS resolver. */
export async function createTestIdentityKeys(
  kid = 'test-key-1',
): Promise<TestIdentityProviderKeys> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  return { privateKey, publicJwk, kid, jwks: createLocalJwks(publicKey) };
}

/** A JWKS resolver over one in-memory key. */
export function createLocalJwks(publicKey: KeyLike) {
  return async () => publicKey;
}

export interface TestTokenClaims {
  subject?: string;
  issuer?: string;
  audience?: string | string[];
  /** Keycloak's authorized party. Checked in addition to `aud`. */
  authorizedParty?: string;
  email?: string;
  realmRoles?: string[];
  clientRoles?: Record<string, string[]>;
  groups?: string[];
  /** Authentication context class. A multi-factor value grants high assurance. */
  acr?: string;
  /** Authentication methods. */
  amr?: string[];
  expiresInSeconds?: number;
  issuedAtSeconds?: number;
  notBeforeSeconds?: number;
  jti?: string;
  /**
   * Sign a token with no `sub`.
   *
   * A real case rather than a contrivance: a misconfigured provider, or a token from
   * an endpoint that does not issue subject-bound tokens, and an implementation that
   * assumes `sub` is present derives an actor with an empty id.
   */
  omitSubject?: boolean;
  extra?: Record<string, unknown>;
}

/**
 * Signs a token that should verify.
 *
 * Everything a test then does to break it is a deliberate, named mutation, which
 * keeps the negative cases readable: `wrongAudience(...)` says what is being tested
 * in a way that a hand-assembled payload does not.
 */
export async function signTestToken(
  keys: TestIdentityProviderKeys,
  claims: TestTokenClaims = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    email: claims.email ?? 'ada@example.test',
    ...(claims.realmRoles ? { realm_access: { roles: claims.realmRoles } } : {}),
    ...(claims.clientRoles
      ? {
          resource_access: Object.fromEntries(
            Object.entries(claims.clientRoles).map(([client, roles]) => [client, { roles }]),
          ),
        }
      : {}),
    ...(claims.groups ? { groups: claims.groups } : {}),
    ...(claims.acr ? { acr: claims.acr } : {}),
    ...(claims.amr ? { amr: claims.amr } : {}),
    ...(claims.authorizedParty ? { azp: claims.authorizedParty } : {}),
    ...(claims.extra ?? {}),
  };

  let token = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid })
    .setIssuer(claims.issuer ?? 'https://idp.test/realms/trustos')
    .setAudience(claims.audience ?? 'trustos-api')
    .setIssuedAt(claims.issuedAtSeconds ?? nowSeconds)
    .setExpirationTime(nowSeconds + (claims.expiresInSeconds ?? 300))
    .setJti(claims.jti ?? `jti_${nowSeconds}`);

  if (!claims.omitSubject) token = token.setSubject(claims.subject ?? 'user_ada');
  if (claims.notBeforeSeconds !== undefined) token = token.setNotBefore(claims.notBeforeSeconds);

  return token.sign(keys.privateKey);
}

/**
 * Named mutations.
 *
 * Each returns a token that a correct implementation must refuse, and each maps to a
 * real mistake:
 *
 *   `tamperedPayload`   — an implementation that decodes without verifying
 *   `wrongIssuer`       — an implementation that skips `iss`
 *   `wrongAudience`     — a token minted for another service in the same realm
 *   `expired`           — a clock-skew window set generously enough to matter
 *   `notYetValid`       — an implementation that ignores `nbf`
 *   `signedByAnotherKey`— an attacker with their own key pair
 *   `algNone`           — the oldest JWT bypass there is
 */
export function tamperedPayload(token: string, patch: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('not a JWT');

  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  const edited = Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString('base64url');

  // The original signature is kept. A verifying implementation rejects it; one that
  // only decodes accepts the edited claims, which is the whole point of the case.
  return `${header}.${edited}.${signature}`;
}

export async function wrongIssuer(keys: TestIdentityProviderKeys, claims: TestTokenClaims = {}) {
  return signTestToken(keys, { ...claims, issuer: 'https://evil.test/realms/trustos' });
}

export async function wrongAudience(keys: TestIdentityProviderKeys, claims: TestTokenClaims = {}) {
  return signTestToken(keys, { ...claims, audience: 'some-other-service' });
}

export async function expiredToken(keys: TestIdentityProviderKeys, claims: TestTokenClaims = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Well past any reasonable clock-skew allowance.
  return signTestToken(keys, {
    ...claims,
    issuedAtSeconds: nowSeconds - 7200,
    expiresInSeconds: -3600,
  });
}

export async function notYetValidToken(
  keys: TestIdentityProviderKeys,
  claims: TestTokenClaims = {},
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return signTestToken(keys, { ...claims, notBeforeSeconds: nowSeconds + 3600 });
}

/** A token signed by a key the identity provider does not publish. */
export async function signedByAnotherKey(claims: TestTokenClaims = {}): Promise<string> {
  const attacker = await createTestIdentityKeys('attacker-key');
  return signTestToken(attacker, claims);
}

/**
 * An unsigned token claiming `alg: none`.
 *
 * The oldest JWT bypass there is, and it still works against any implementation that
 * does not pin the algorithm list.
 */
export function algNoneToken(claims: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const nowSeconds = Math.floor(Date.now() / 1000);

  const payload = Buffer.from(
    JSON.stringify({
      sub: 'user_attacker',
      iss: 'https://idp.test/realms/trustos',
      aud: 'trustos-api',
      exp: nowSeconds + 3600,
      realm_access: { roles: ['admin'] },
      ...claims,
    }),
  ).toString('base64url');

  return `${header}.${payload}.`;
}
