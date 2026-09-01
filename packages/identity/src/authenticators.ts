import type { ActorContext } from '@trustsystem/shared-types';

/**
 * Credential authenticators.
 *
 * A request can arrive with a bearer token, an API key, or a service-account
 * credential, and every one of them has to end up as the same `ActorContext` —
 * otherwise a module, a guard or an audit record has to know which kind of caller
 * it is dealing with, and that knowledge spreads.
 *
 * This is the port that makes that possible. `@trustsystem/identity` implements the
 * bearer-token authenticator; `@trustsystem/api-keys` and
 * `@trustsystem/service-accounts` implement their own and depend on *this* package
 * rather than the other way round, so identity never learns what an API key is.
 *
 * Order matters and is the application's choice. The guard tries each in turn and
 * stops at the first that produces an actor; an authenticator that does not
 * recognise the credential returns null rather than throwing, so a request with an
 * API key does not fail because the bearer authenticator saw no bearer token.
 */

export interface CredentialRequest {
  /** Lower-cased header names to values. */
  headers: Record<string, string | string[] | undefined>;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  method: string;
  path: string;
}

export interface CredentialAuthenticator {
  /** Stable id, used in security events and in the portal's provider list. */
  readonly id: string;
  /**
   * Resolves an actor, or returns null when this authenticator does not
   * recognise the credential.
   *
   * Returning null means "not mine"; throwing means "mine, and invalid". The
   * distinction is what lets several authenticators coexist without a bad API key
   * being reported as a missing bearer token.
   */
  authenticate(request: CredentialRequest): Promise<ActorContext | null>;
}

/**
 * Reads a scheme-qualified credential from the `Authorization` header.
 *
 * Only that header. Never a query parameter, which ends up in access logs,
 * browser history and referrer headers, and never a request body, which is not
 * available to a guard without buffering it.
 */
export function readAuthorizationCredential(
  headers: Record<string, string | string[] | undefined>,
  scheme: string,
): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  const separator = value.indexOf(' ');
  if (separator <= 0) return null;

  if (value.slice(0, separator).toLowerCase() !== scheme.toLowerCase()) return null;
  return value.slice(separator + 1).trim() || null;
}

/** Reads a single-valued header, tolerating the array form. */
export function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || null;
}
