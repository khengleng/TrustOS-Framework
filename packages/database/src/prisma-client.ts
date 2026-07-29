import { PrismaClient, Prisma } from '@prisma/client';
import type { AppConfig } from '@trustos/config';

/** Minimal logger surface; @trustos/logging's Logger satisfies it. */
export interface DatabaseLogger {
  debug(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * Constructor options shared by every client in the system — the Nest-managed
 * `PrismaService`, the seed script, and one-off maintenance scripts. Keeping
 * one source of truth means a pool or logging change cannot apply to some
 * clients and not others.
 */
export function prismaClientOptions(config: AppConfig): Prisma.PrismaClientOptions {
  return {
    datasources: { db: { url: config.database.url } },
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
    errorFormat: config.isProduction ? 'minimal' : 'pretty',
  };
}

export interface AttachLogHandlersOptions {
  config: AppConfig;
  logger: DatabaseLogger;
  /** Queries at or above this duration are logged. */
  slowQueryMs?: number;
}

/**
 * Routes Prisma's log events into the structured logger.
 *
 * Query *text* is logged; query *parameters* are not. Parameters routinely
 * contain email addresses, password hashes and tokens, and a log sink is a
 * lower-trust store than the database (docs/security-standards.md).
 */
export function attachLogHandlers(client: PrismaClient, options: AttachLogHandlersOptions): void {
  const { logger, config } = options;
  const slowQueryMs = options.slowQueryMs ?? (config.isProduction ? 500 : 200);

  client.$on('query' as never, (event: Prisma.QueryEvent) => {
    if (event.duration < slowQueryMs) return;
    logger.warn({ durationMs: event.duration, query: event.query }, 'slow database query');
  });
  client.$on('warn' as never, (event: Prisma.LogEvent) => {
    logger.warn({ target: event.target }, event.message);
  });
  client.$on('error' as never, (event: Prisma.LogEvent) => {
    logger.error({ target: event.target }, event.message);
  });
}

export interface CreatePrismaClientOptions {
  config: AppConfig;
  logger?: DatabaseLogger;
  slowQueryMs?: number;
}

/** Standalone client for scripts that run outside the Nest container. */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const client = new PrismaClient(prismaClientOptions(options.config));
  if (options.logger) {
    attachLogHandlers(client, {
      config: options.config,
      logger: options.logger,
      ...(options.slowQueryMs !== undefined ? { slowQueryMs: options.slowQueryMs } : {}),
    });
  }
  return client;
}

/** Round-trips a trivial query; used by the readiness probe. */
export async function checkDatabaseConnection(
  client: Pick<PrismaClient, '$queryRaw'>,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    await client.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'unknown database error',
    };
  }
}
