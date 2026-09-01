import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';

/**
 * Authorization code flow with PKCE.
 *
 * PKCE is not optional for a browser application, and the reason is worth stating
 * because it is often described as "for mobile apps". A single-page application
 * cannot hold a client secret — anything shipped to a browser is public — so the
 * authorization code is the only thing standing between an attacker who
 * intercepts the redirect and a set of tokens. PKCE binds the code to a secret
 * the *client generated and never sent*, so an intercepted code is useless
 * without it.
 *
 * `S256` only. `plain` exists in the specification for clients that cannot compute
 * SHA-256, which in 2026 means none, and it reduces PKCE to sending the secret
 * alongside the thing it was meant to protect.
 *
 * This module builds and verifies the parameters. It makes no HTTP call: the
 * redirect is the browser's, and the token exchange belongs to the application,
 * which has the client credentials.
 */

export const PKCE_METHOD = 'S256' as const;

export interface PkcePair {
  /** Held by the client. Never sent to the authorization endpoint. */
  verifier: string;
  /** Sent to the authorization endpoint. */
  challenge: string;
  method: typeof PKCE_METHOD;
}

/**
 * Generates a verifier and its challenge.
 *
 * 96 random bytes, base64url-encoded to 128 characters — the maximum the
 * specification allows, and it costs nothing to take it.
 */
export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(96));
  return { verifier, challenge: pkceChallenge(verifier), method: PKCE_METHOD };
}

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

/**
 * Verifies a returned verifier against a stored challenge.
 *
 * Constant-time, because a comparison that returns early leaks how much of a
 * candidate matched.
 */
export function verifyPkce(verifier: string, expectedChallenge: string): boolean {
  const actual = Buffer.from(pkceChallenge(verifier));
  const expected = Buffer.from(expectedChallenge);

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface AuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  /** Anti-CSRF value, echoed back and compared. Not the same as the verifier. */
  state: string;
  /** Replay protection for the id token. */
  nonce: string;
  challenge: string;
  scopes?: string[];
  /**
   * Requested authentication context.
   *
   * How a step-up is asked for: a route that needs MFA sends the deployment's
   * multi-factor `acr` value, and the provider prompts for a second factor rather
   * than returning the existing single-factor session.
   */
  acrValues?: string[];
  /** `login` forces re-authentication; `none` requires an existing session. */
  prompt?: 'none' | 'login' | 'consent' | 'select_account';
}

/** Builds the URL a browser is redirected to. */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint);

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', PKCE_METHOD);
  url.searchParams.set('scope', (input.scopes ?? ['openid', 'profile', 'email']).join(' '));

  if (input.acrValues?.length) url.searchParams.set('acr_values', input.acrValues.join(' '));
  if (input.prompt) url.searchParams.set('prompt', input.prompt);

  return url.toString();
}

/** A random, URL-safe value for `state` and `nonce`. */
export function createRandomValue(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

/**
 * Validates the redirect this service received.
 *
 * Four checks, and skipping any of them breaks the flow in a way that still works
 * for a legitimate user:
 *
 *   * `error` present — the provider refused, and continuing would treat a
 *     rejection as a success.
 *   * `state` matches — without it, an attacker can complete *their* login in the
 *     victim's browser, which is login CSRF.
 *   * `code` present.
 *   * The stored PKCE verifier exists for this state.
 */
export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export function validateCallback(
  params: CallbackParams,
  expected: { state: string; verifier: string },
): { code: string; verifier: string } {
  if (params.error) {
    throw ApiError.unauthorized('Sign-in was not completed.', {
      reason: 'oidc_callback_error',
      // The provider's own error code, which is operator detail rather than a
      // message for the person who was signing in.
      providerError: params.error,
      providerErrorDescription: params.error_description ?? null,
    });
  }

  if (!params.state || !constantTimeEquals(params.state, expected.state)) {
    // Login CSRF: without this an attacker completes their own login in the
    // victim's browser and the victim then acts as the attacker's account.
    throw ApiError.unauthorized('Sign-in was not completed.', {
      reason: 'oidc_state_mismatch',
    });
  }

  if (!params.code) {
    throw ApiError.unauthorized('Sign-in was not completed.', {
      reason: 'oidc_missing_code',
    });
  }

  if (!expected.verifier) {
    throw ApiError.unauthorized('Sign-in was not completed.', {
      reason: 'oidc_missing_verifier',
    });
  }

  return { code: params.code, verifier: expected.verifier };
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}
