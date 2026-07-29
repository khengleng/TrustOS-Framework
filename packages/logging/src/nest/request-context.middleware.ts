import type { AppConfig } from '@trustos/config';
import type { RequestContext } from '@trustos/shared-types';
import type { Logger } from '../logger';
import { generateRequestId, getRequestContext, runWithRequestContext } from '../request-context';

/** Everything a metrics recorder needs, emitted once per finished request. */
export interface RequestCompletion {
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  actorId: string | null;
  organizationId: string | null;
}

export interface RequestContextMiddlewareOptions {
  config: AppConfig;
  logger: Logger;
  /**
   * Called once per finished request. This is the single hook
   * @trustos/observability uses for timing and error metrics — there is no
   * second `res.on('finish')` listener anywhere in the framework.
   */
  onComplete?: (completion: RequestCompletion) => void;
  /** Paths excluded from access logging, e.g. health probes. */
  ignorePaths?: string[];
}

type MinimalRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
  id?: string;
};

type MinimalResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  on: (event: string, listener: () => void) => void;
};

/**
 * Establishes request correlation and emits the access log.
 *
 * Register it first, before every other middleware, so that anything failing
 * downstream still has a request id to report. The id is echoed back in the
 * response header, which is what lets a user paste "req_..." into a support
 * ticket and have it mean something.
 */
export function requestContextMiddleware(options: RequestContextMiddlewareOptions) {
  const { config, logger, onComplete } = options;
  const headerName = config.http.requestIdHeader;
  const ignore = new Set(options.ignorePaths ?? []);

  return function trustosRequestContext(
    req: MinimalRequest,
    res: MinimalResponse,
    next: () => void,
  ): void {
    const startedAt = process.hrtime.bigint();
    const requestId = readInboundRequestId(req, headerName) ?? generateRequestId();
    const path = req.originalUrl ?? req.url ?? '';

    const context: RequestContext = {
      requestId,
      method: req.method ?? 'UNKNOWN',
      path,
      ipAddress: resolveClientIp(req, config.http.trustProxy),
      userAgent: firstHeader(req.headers['user-agent']) ?? null,
      receivedAt: new Date(),
      actor: null,
      organizationId: null,
    };

    req.id = requestId;
    res.setHeader(headerName, requestId);

    runWithRequestContext(context, () => {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        // Read the context back rather than the closure: the auth guard has
        // populated the actor by now.
        const finished = getRequestContext() ?? context;

        const completion: RequestCompletion = {
          requestId,
          method: context.method,
          path: context.path,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
          actorId: finished.actor?.userId ?? null,
          organizationId: finished.organizationId,
        };

        onComplete?.(completion);

        if (ignore.has(path)) return;
        logger[res.statusCode >= 500 ? 'error' : 'info'](
          {
            method: completion.method,
            path: completion.path,
            statusCode: completion.statusCode,
            durationMs: completion.durationMs,
            ip: context.ipAddress,
            userAgent: context.userAgent,
          },
          'request completed',
        );
      });

      next();
    });
  };
}

/**
 * Accepts an inbound correlation id only when it looks like one of ours.
 *
 * A caller-supplied id is convenient for tracing across services and is also
 * an injection vector into every log line, so it is length- and charset-bound.
 */
function readInboundRequestId(req: MinimalRequest, headerName: string): string | null {
  const raw = firstHeader(req.headers[headerName]);
  if (!raw) return null;
  return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * `X-Forwarded-For` is trusted only when the deployment says a proxy is in
 * front (Railway, a load balancer). Trusting it unconditionally lets any
 * caller forge the IP recorded in the audit trail.
 */
function resolveClientIp(req: MinimalRequest, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = firstHeader(req.headers['x-forwarded-for']);
    const client = forwarded?.split(',')[0]?.trim();
    if (client) return client;
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}
