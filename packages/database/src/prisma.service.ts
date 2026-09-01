import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '@trustsystem/config';
import { APP_CONFIG, DATABASE_LOGGER } from './tokens';
import { attachLogHandlers, prismaClientOptions, type DatabaseLogger } from './prisma-client';

/**
 * Nest-managed Prisma client.
 *
 * Extending PrismaClient keeps the full typed API available (`prisma.user…`)
 * while letting Nest own the connection lifecycle, so a shutdown drains the
 * pool instead of dropping in-flight queries.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly databaseLogger: DatabaseLogger | undefined;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() @Inject(DATABASE_LOGGER) logger?: DatabaseLogger,
  ) {
    super(prismaClientOptions(config));
    this.databaseLogger = logger ?? undefined;
    if (logger) attachLogHandlers(this, { config, logger });
  }

  /**
   * Opens the pool eagerly, but does **not** fail startup if the database is
   * unreachable.
   *
   * This is the counterpart to the `/health` vs `/ready` split: the process
   * binds its port and answers liveness, while `/ready` returns 503 until the
   * database answers. Crashing here instead would mean a database restart
   * takes every application instance down with it, and a rolling deploy could
   * not start at all during a brief outage. Prisma reconnects on the next
   * query, so recovery needs no intervention.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      this.databaseLogger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'database unavailable at startup; serving readiness failures until it returns',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
