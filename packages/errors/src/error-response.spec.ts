import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { isApiErrorBody, toErrorResponse } from './error-response';

describe('toErrorResponse', () => {
  it('emits the documented body shape for a deliberate error', () => {
    const { status, body } = toErrorResponse(ApiError.forbidden(), {
      requestId: 'req_abc',
      environment: 'production',
    });

    expect(status).toBe(403);
    expect(body).toEqual({
      error: 'forbidden',
      message: 'You do not have permission to perform this action.',
      requestId: 'req_abc',
    });
  });

  it('never leaks the message or stack of an unexpected error in production', () => {
    const leaky = new Error('connect ECONNREFUSED postgres://user:hunter2@10.0.0.4:5432');

    const { status, body, logContext } = toErrorResponse(leaky, {
      requestId: 'req_abc',
      environment: 'production',
    });

    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'internal_error',
      message: 'An unexpected error occurred.',
      requestId: 'req_abc',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(body.debug).toBeUndefined();
    // The detail is preserved for operators, just not for callers.
    expect(logContext.errorMessage).toContain('hunter2');
    expect(logContext.expected).toBe(false);
  });

  it('includes debug detail outside production to keep local work diagnosable', () => {
    const { body } = toErrorResponse(new Error('boom'), {
      requestId: 'req_abc',
      environment: 'development',
    });

    expect(body.debug?.message).toBe('boom');
  });

  it('defaults to production behaviour when the environment is unknown', () => {
    const { body } = toErrorResponse(new Error('boom'), { requestId: 'req_abc' });
    expect(body.debug).toBeUndefined();
  });

  it('surfaces field details only for validation errors', () => {
    const { body } = toErrorResponse(
      ApiError.validation([{ path: 'email', message: 'Invalid email address.' }]),
      { requestId: 'req_abc', environment: 'production' },
    );

    expect(body.error).toBe('validation_error');
    expect(body.details).toEqual([{ path: 'email', message: 'Invalid email address.' }]);
  });

  it('keeps ApiError.context out of the response but inside the log payload', () => {
    const { body, logContext } = toErrorResponse(
      ApiError.forbidden('You do not have permission to perform this action.', {
        attemptedOrganizationId: 'org_other',
      }),
      { requestId: 'req_abc', environment: 'production' },
    );

    expect('attemptedOrganizationId' in body).toBe(false);
    expect(logContext.attemptedOrganizationId).toBe('org_other');
  });

  it('maps framework exceptions that carry an HTTP status', () => {
    class HttpException extends Error {
      constructor(
        message: string,
        private readonly statusCode: number,
      ) {
        super(message);
      }
      getStatus() {
        return this.statusCode;
      }
    }

    const { status, body } = toErrorResponse(new HttpException('Cannot GET /nope', 404), {
      requestId: 'req_abc',
      environment: 'production',
    });

    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('withholds framework 5xx messages', () => {
    const { body } = toErrorResponse(
      { status: 503, message: 'upstream pg pool exhausted' },
      {
        requestId: 'req_abc',
        environment: 'production',
      },
    );

    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('An unexpected error occurred.');
  });
});

describe('isApiErrorBody', () => {
  it('accepts a well-formed body and rejects anything else', () => {
    expect(isApiErrorBody({ error: 'not_found', message: 'x', requestId: 'req_1' })).toBe(true);
    expect(isApiErrorBody({ error: 'teapot', message: 'x', requestId: 'req_1' })).toBe(false);
    expect(isApiErrorBody('<html>502 Bad Gateway</html>')).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
  });
});
