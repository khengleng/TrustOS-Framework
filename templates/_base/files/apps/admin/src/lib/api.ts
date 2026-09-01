import { isApiErrorBody, type ApiErrorBody, type ErrorCode } from '@trustsystem/errors';

/**
 * Browser API client.
 *
 * It imports @trustsystem/errors — which is browser-safe by design — so the admin
 * app parses exactly the error contract the API produces, rather than
 * re-deriving it from response shapes.
 */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000/api';

/**
 * A failed API call, normalized.
 *
 * `requestId` is the whole point: when a user reports a failure, this is the
 * string that finds the matching server logs and audit records.
 */
export class ApiClientError extends Error {
  readonly code: ErrorCode | 'network_error';
  readonly status: number;
  readonly requestId: string | null;
  readonly details: ApiErrorBody['details'];

  constructor(init: {
    code: ErrorCode | 'network_error';
    message: string;
    status: number;
    requestId?: string | null;
    details?: ApiErrorBody['details'];
  }) {
    super(init.message);
    this.name = 'ApiClientError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details;
  }

  get isAuthExpired(): boolean {
    return this.code === 'unauthorized';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  accessToken?: string | null;
  signal?: AbortSignal;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, accessToken, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // A network failure has no requestId and no server-side trace; say so
    // rather than presenting it as an application error.
    throw new ApiClientError({
      code: 'network_error',
      status: 0,
      message:
        error instanceof Error && error.name === 'AbortError'
          ? 'The request was cancelled.'
          : 'Could not reach the API. Check that it is running and that CORS_ORIGINS includes this app.',
    });
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    if (isApiErrorBody(payload)) {
      throw new ApiClientError({
        code: payload.error,
        message: payload.message,
        status: response.status,
        requestId: payload.requestId,
        ...(payload.details ? { details: payload.details } : {}),
      });
    }

    // Not a TrustOS error body — a proxy error page, a gateway timeout. Do not
    // render whatever HTML came back.
    throw new ApiClientError({
      code: 'network_error',
      status: response.status,
      message: `The API returned an unexpected ${response.status} response.`,
      requestId: response.headers.get('x-request-id'),
    });
  }

  return payload as T;
}

/** Turns any thrown value into text safe to render. */
export function describeError(error: unknown): { message: string; requestId: string | null } {
  if (error instanceof ApiClientError) {
    return { message: error.message, requestId: error.requestId };
  }
  return { message: 'Something went wrong.', requestId: null };
}
