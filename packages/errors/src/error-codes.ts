/**
 * The complete set of error codes a TrustOS API may return.
 *
 * Clients switch on these strings, so the list is part of the public API
 * contract: codes may be added, never renamed or removed (see
 * docs/coding-standards.md, "API compatibility").
 */
export const ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Canonical HTTP status for each code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

/**
 * Messages that are safe to show a caller verbatim.
 *
 * Defaults are deliberately vague: a specific reason ("user exists", "wrong
 * password") is useful to an attacker enumerating accounts. Override per call
 * site only when the specificity is genuinely safe.
 */
export const DEFAULT_ERROR_MESSAGES: Record<ErrorCode, string> = {
  validation_error: 'The request payload failed validation.',
  unauthorized: 'Authentication is required to perform this action.',
  forbidden: 'You do not have permission to perform this action.',
  not_found: 'The requested resource was not found.',
  conflict: 'The request conflicts with the current state of the resource.',
  rate_limited: 'Too many requests. Please retry later.',
  internal_error: 'An unexpected error occurred.',
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
