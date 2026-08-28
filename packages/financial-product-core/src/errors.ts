import { ApiError, isApiError, type ErrorCode } from '@trustos/errors';

/**
 * The product layer's refusals.
 *
 * Every one of these is a *refusal*, not a failure: the layer decided not to do something and
 * the caller needs to know which rule decided. A single `validation_error` across twenty call
 * sites produces support tickets nobody can triage, because "invalid" covers an unapproved
 * block, a stale version and a tenant boundary — three problems with three different fixes and
 * three different people to call.
 *
 * The codes are stable strings. They appear in audit records and in client retry logic, so
 * renaming one is a breaking change even though nothing in TypeScript notices.
 */

export const PRODUCT_ERROR_CODES = [
  'product_not_found',
  'product_version_not_found',
  'product_not_executable',
  'product_definition_immutable',
  'product_definition_invalid',
  'product_lifecycle_transition_invalid',
  'product_approval_required',
  'product_self_approval_refused',
  'product_block_not_approved',
  'product_block_transition_not_allowed',
  'product_connector_not_approved',
  'product_provider_unbound',
  'product_rule_invalid',
  'product_variant_override_refused',
  'product_reference_unknown',
  'product_idempotency_conflict',
  'product_version_binding_broken',
  'product_tenant_mismatch',
  'product_sandbox_only',
] as const;

export type ProductErrorCode = (typeof PRODUCT_ERROR_CODES)[number];

/**
 * Diagnostic context attached to a refusal.
 *
 * Identifiers, rule names and lifecycle states. Never a payload, never an amount, never a
 * credential — this travels into logs and audit records, and `@trustos/errors` says plainly that
 * `context` is for things a log sink may hold.
 */
export interface ProductErrorContext {
  productId?: string;
  version?: string;
  blockKey?: string;
  connectorId?: string;
  rule?: string;
  expected?: string;
  actual?: string;
}

/**
 * Which framework error code each refusal maps to.
 *
 * `product_tenant_mismatch` is `not_found` and not `forbidden`, and that is the entry worth
 * reading twice. A 403 confirms the product exists, which turns the catalog into an enumeration
 * oracle for anybody with a valid token and a list of guesses. Every other tenant boundary in
 * this framework makes the same choice; this one has to as well, or the boundary has a hole
 * shaped like one status code.
 */
const ERROR_CODE_BY_REFUSAL: Record<ProductErrorCode, ErrorCode> = {
  product_not_found: 'not_found',
  product_version_not_found: 'not_found',
  product_tenant_mismatch: 'not_found',

  product_not_executable: 'conflict',
  product_definition_immutable: 'conflict',
  product_lifecycle_transition_invalid: 'conflict',
  product_idempotency_conflict: 'conflict',
  product_version_binding_broken: 'conflict',

  product_self_approval_refused: 'forbidden',
  product_approval_required: 'forbidden',
  product_sandbox_only: 'forbidden',

  product_definition_invalid: 'validation_error',
  product_block_not_approved: 'validation_error',
  product_block_transition_not_allowed: 'validation_error',
  product_connector_not_approved: 'validation_error',
  product_provider_unbound: 'validation_error',
  product_rule_invalid: 'validation_error',
  product_variant_override_refused: 'validation_error',
  product_reference_unknown: 'validation_error',
};

/**
 * Builds a refusal.
 *
 * The product code goes into `context` rather than into the message, because the message is read
 * by a person and the code is read by a program — and a program that has to substring-match an
 * English sentence breaks the first time somebody improves the wording.
 */
export function productError(
  code: ProductErrorCode,
  message: string,
  context: ProductErrorContext = {},
): ApiError {
  return new ApiError(ERROR_CODE_BY_REFUSAL[code], {
    message,
    context: { productErrorCode: code, ...context },
  });
}

/** Reads the refusal back off an error, for a caller deciding whether to retry. */
export function productErrorCode(error: unknown): ProductErrorCode | null {
  if (!isApiError(error)) return null;
  const code = (error as ApiError).context?.productErrorCode;
  return typeof code === 'string' && (PRODUCT_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ProductErrorCode)
    : null;
}

/** The HTTP status a refusal produces. Exported so the API package can document it. */
export function productErrorStatus(code: ProductErrorCode): number {
  return new ApiError(ERROR_CODE_BY_REFUSAL[code]).status;
}
