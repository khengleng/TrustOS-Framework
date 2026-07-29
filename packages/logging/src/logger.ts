import pino, { type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '@trustos/config';
import { PINO_REDACT_PATHS, REDACTED, deepRedact } from './redaction';
import { getRequestContext, requestLogFields } from './request-context';

export type { Logger };

/**
 * The logging surface framework packages depend on.
 *
 * Packages accept a `LoggerPort` rather than a Pino logger so they can be
 * tested with a two-line fake and so a future backend swap touches one file.
 */
export interface LoggerPort {
  fatal(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
  debug(payload: Record<string, unknown>, message: string): void;
  child(bindings: Record<string, unknown>): LoggerPort;
}

export interface CreateLoggerOptions {
  /** Extra fields attached to every line, e.g. `{ component: 'worker' }`. */
  base?: Record<string, unknown>;
  /** Pretty-print regardless of environment. Off in production, always. */
  pretty?: boolean;
}

/**
 * Builds the root logger for a service.
 *
 * Every line carries service name, environment and version, plus the request
 * id / actor id / organization id of the active request when there is one.
 * Redaction is applied twice — Pino's fast path for known request shapes, and
 * a deep pass for everything else — because a missed secret in a log sink is
 * not recoverable after the fact.
 */
export function createLogger(config: AppConfig, options: CreateLoggerOptions = {}): Logger {
  const usePretty = options.pretty ?? (config.isDevelopment && !config.isProduction);

  const pinoOptions: LoggerOptions = {
    level: config.logging.level,
    base: {
      service: config.serviceName,
      env: config.env,
      version: config.serviceVersion,
      ...options.base,
    },
    redact: { paths: PINO_REDACT_PATHS, censor: REDACTED },
    // Attaches request correlation without the caller passing it every time.
    mixin: () => requestLogFields(getRequestContext()),
    formatters: {
      level: (label) => ({ level: label }),
      // The safety net: any object logged anywhere is key-scanned for secrets.
      log: (object) => deepRedact(object) as Record<string, unknown>,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (usePretty) {
    return pino({
      ...pinoOptions,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(pinoOptions);
}

/** A no-op logger for tests and for library defaults. */
export function createNullLogger(): LoggerPort {
  const noop = () => undefined;
  const logger: LoggerPort = {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    child: () => logger,
  };
  return logger;
}
