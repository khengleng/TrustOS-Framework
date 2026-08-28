import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { toErrorResponse } from '../error-response';

/**
 * Minimal logger surface so this leaf package stays dependency-free.
 * @trustos/logging's logger satisfies it structurally.
 */
export interface ErrorFilterLogger {
  error(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface AllExceptionsFilterOptions {
  environment: string;
  logger?: ErrorFilterLogger;
  /** Header carrying the correlation id. Defaults to `x-request-id`. */
  requestIdHeader?: string;
}

/**
 * Converts every escaping exception into the standard TrustOS error body.
 *
 * Register it globally (`app.useGlobalFilters(...)`) so no route can respond
 * with an unformatted error. Expected errors (4xx) log at warn, unexpected
 * ones at error with the full stack — which is where stacks stay.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly requestIdHeader: string;

  constructor(private readonly options: AllExceptionsFilterOptions) {
    this.requestIdHeader = options.requestIdHeader ?? 'x-request-id';
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{
      id?: string;
      headers?: Record<string, string | string[] | undefined>;
      method?: string;
      url?: string;
    }>();
    const response = http.getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
      headersSent?: boolean;
    }>();

    const requestId = this.resolveRequestId(request);
    const { status, body, logContext } = toErrorResponse(exception, {
      requestId,
      environment: this.options.environment,
    });

    const logPayload = {
      ...logContext,
      requestId,
      method: request?.method,
      path: request?.url,
      status,
    };

    if (this.options.logger) {
      if (status >= 500) {
        this.options.logger.error(logPayload, 'Unhandled request failure');
      } else {
        this.options.logger.warn(logPayload, 'Request rejected');
      }
    }

    if (response?.headersSent) return;
    response.status(status).json(body);
  }

  private resolveRequestId(request: {
    id?: string;
    headers?: Record<string, string | string[] | undefined>;
  }): string {
    if (typeof request?.id === 'string' && request.id) return request.id;
    const header = request?.headers?.[this.requestIdHeader];
    if (typeof header === 'string' && header) return header;
    if (Array.isArray(header) && typeof header[0] === 'string') return header[0];
    return 'req_unknown';
  }
}
