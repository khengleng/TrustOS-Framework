import type { LoggerService } from '@nestjs/common';
import type { Logger } from '../logger';

/**
 * Routes NestJS's own output through Pino.
 *
 * Without this, framework startup lines are unstructured text while
 * application lines are JSON, and a log aggregator sees two formats from one
 * service.
 */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: unknown): void {
    this.logger.info({ context: asContext(context) }, String(message));
  }

  error(message: unknown, stack?: unknown, context?: unknown): void {
    this.logger.error(
      { context: asContext(context), stack: typeof stack === 'string' ? stack : undefined },
      String(message),
    );
  }

  warn(message: unknown, context?: unknown): void {
    this.logger.warn({ context: asContext(context) }, String(message));
  }

  debug(message: unknown, context?: unknown): void {
    this.logger.debug({ context: asContext(context) }, String(message));
  }

  verbose(message: unknown, context?: unknown): void {
    this.logger.trace({ context: asContext(context) }, String(message));
  }
}

function asContext(context: unknown): string | undefined {
  return typeof context === 'string' ? context : undefined;
}
