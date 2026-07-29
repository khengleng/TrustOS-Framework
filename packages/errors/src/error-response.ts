import { ApiError, isApiError, type ValidationDetail } from './api-error';
import { DEFAULT_ERROR_MESSAGES, ERROR_STATUS, isErrorCode, type ErrorCode } from './error-codes';

/**
 * The wire format for every non-2xx TrustOS response.
 *
 *   { "error": "forbidden",
 *     "message": "You do not have permission to perform this action.",
 *     "requestId": "req_xxx" }
 *
 * `details` is additive and present only for `validation_error`. `debug` is
 * present only outside production.
 */
export interface ApiErrorBody {
  error: ErrorCode;
  message: string;
  requestId: string;
  details?: ValidationDetail[];
  debug?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface ToErrorResponseOptions {
  requestId: string;
  /** Anything other than 'production' permits debug detail in the response. */
  environment?: string;
}

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  /**
   * Everything worth logging that must NOT go on the wire: internal context,
   * the original message for unexpected errors, and the stack.
   */
  logContext: Record<string, unknown>;
}

/**
 * Converts any thrown value into a client-safe response plus a log payload.
 *
 * The safety rule lives here and nowhere else: an unexpected error never
 * contributes its message, stack, or shape to the response in production.
 */
export function toErrorResponse(error: unknown, options: ToErrorResponseOptions): ErrorResponse {
  const isProduction = (options.environment ?? 'production') === 'production';
  const normalized = normalizeError(error);

  const body: ApiErrorBody = {
    error: normalized.code,
    message: normalized.clientMessage,
    requestId: options.requestId,
  };

  if (normalized.code === 'validation_error' && normalized.details?.length) {
    body.details = normalized.details;
  }

  if (!isProduction && normalized.original instanceof Error) {
    body.debug = {
      name: normalized.original.name,
      message: normalized.original.message,
      ...(normalized.original.stack ? { stack: normalized.original.stack } : {}),
    };
  }

  return {
    status: normalized.status,
    body,
    logContext: {
      errorCode: normalized.code,
      errorName: normalized.original instanceof Error ? normalized.original.name : typeof error,
      errorMessage:
        normalized.original instanceof Error ? normalized.original.message : String(error),
      ...(normalized.original instanceof Error && normalized.original.stack
        ? { stack: normalized.original.stack }
        : {}),
      ...(normalized.context ?? {}),
      expected: normalized.expected,
    },
  };
}

interface NormalizedError {
  code: ErrorCode;
  status: number;
  clientMessage: string;
  details?: ValidationDetail[];
  context?: Record<string, unknown>;
  original: unknown;
  /** False when the error was not raised deliberately as an ApiError. */
  expected: boolean;
}

function normalizeError(error: unknown): NormalizedError {
  if (isApiError(error)) {
    const apiError = error as ApiError;
    return {
      code: apiError.code,
      status: apiError.status,
      clientMessage: apiError.message || DEFAULT_ERROR_MESSAGES[apiError.code],
      ...(apiError.details ? { details: apiError.details } : {}),
      ...(apiError.context ? { context: apiError.context } : {}),
      original: error,
      expected: true,
    };
  }

  const framework = readFrameworkHttpError(error);
  if (framework) return framework;

  return {
    code: 'internal_error',
    status: ERROR_STATUS.internal_error,
    // Deliberately discards the original message: unexpected errors routinely
    // embed connection strings, SQL, and file paths.
    clientMessage: DEFAULT_ERROR_MESSAGES.internal_error,
    original: error,
    expected: false,
  };
}

/**
 * Recognizes an error carrying an HTTP status (e.g. a NestJS HttpException)
 * without importing the framework into this browser-safe module.
 */
function readFrameworkHttpError(error: unknown): NormalizedError | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { status?: unknown; getStatus?: unknown; message?: unknown };
  const status =
    typeof candidate.getStatus === 'function'
      ? Number((candidate.getStatus as () => number)())
      : typeof candidate.status === 'number'
        ? candidate.status
        : null;

  if (status === null || !Number.isFinite(status) || status < 400 || status > 599) return null;

  const code = statusToErrorCode(status);
  return {
    code,
    status,
    // Framework exceptions (404 route not found, 401 from a guard) carry
    // messages authored by us or by Nest, but we still prefer the safe default
    // for 5xx.
    clientMessage:
      status >= 500
        ? DEFAULT_ERROR_MESSAGES.internal_error
        : typeof candidate.message === 'string' && candidate.message
          ? candidate.message
          : DEFAULT_ERROR_MESSAGES[code],
    original: error,
    expected: status < 500,
  };
}

export function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'validation_error';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'validation_error';
  }
}

/**
 * Client-side guard. Lets the admin app tell a structured TrustOS error from a
 * gateway HTML page or a network failure.
 */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    isErrorCode(body.error) &&
    typeof body.message === 'string' &&
    typeof body.requestId === 'string'
  );
}
