import { DEFAULT_ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from './error-codes';

/** Field-level detail, only ever attached to `validation_error`. */
export interface ValidationDetail {
  path: string;
  message: string;
  code?: string;
}

export interface ApiErrorOptions {
  /** Client-safe message. Defaults to the vague message for the code. */
  message?: string;
  /** Field errors. Only surfaced for `validation_error`. */
  details?: ValidationDetail[];
  /**
   * Diagnostic context for logs and audit records. NEVER serialized into an
   * HTTP response — put nothing here that a caller may not see in a log sink.
   */
  context?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * The single error type framework and product code should throw.
 *
 * Anything else that reaches the exception filter is treated as an unexpected
 * failure and reported as `internal_error` with its message withheld.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ValidationDetail[];
  readonly context?: Record<string, unknown>;
  /** Marks errors whose message is safe to show a caller. */
  readonly isApiError = true as const;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    super(options.message ?? DEFAULT_ERROR_MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options.details) this.details = options.details;
    if (options.context) this.context = options.context;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, ApiError);
  }

  static validation(details: ValidationDetail[], message?: string): ApiError {
    return new ApiError('validation_error', { details, ...(message ? { message } : {}) });
  }

  static unauthorized(message?: string, context?: Record<string, unknown>): ApiError {
    return new ApiError('unauthorized', {
      ...(message ? { message } : {}),
      ...(context ? { context } : {}),
    });
  }

  static forbidden(message?: string, context?: Record<string, unknown>): ApiError {
    return new ApiError('forbidden', {
      ...(message ? { message } : {}),
      ...(context ? { context } : {}),
    });
  }

  static notFound(message?: string, context?: Record<string, unknown>): ApiError {
    return new ApiError('not_found', {
      ...(message ? { message } : {}),
      ...(context ? { context } : {}),
    });
  }

  static conflict(message?: string, context?: Record<string, unknown>): ApiError {
    return new ApiError('conflict', {
      ...(message ? { message } : {}),
      ...(context ? { context } : {}),
    });
  }

  static rateLimited(message?: string, context?: Record<string, unknown>): ApiError {
    return new ApiError('rate_limited', {
      ...(message ? { message } : {}),
      ...(context ? { context } : {}),
    });
  }

  static internal(message?: string, cause?: unknown): ApiError {
    return new ApiError('internal_error', { ...(message ? { message } : {}), cause });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return (
    value instanceof ApiError ||
    (typeof value === 'object' && value !== null && 'isApiError' in value)
  );
}
