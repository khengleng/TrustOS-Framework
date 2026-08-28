import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from './prisma-client';
import type { AppConfig } from '@trustos/config';
import type { Logger } from '@trustos/logging';

/**
 * This application's Prisma client.
 *
 * Why the framework's `PrismaService` is not used directly
 * --------------------------------------------------------
 * `@trustos/database` ships a `PrismaService` generated from the *framework*
 * schema. It knows `User`, `Organization`, `AuditLog` and the rest — but it has
 * never heard of this product's models, at compile time or at run time: its
 * `@prisma/client` resolves inside the framework package.
 *
 * This class extends the client generated from **this** repository's schema,
 * which contains the framework models *and* the product models, because
 * `prisma/schema/` holds both. It is then registered under the framework's
 * `PrismaService` token, so framework code that injects `PrismaService` — the
 * audit sink, the auth stores, the health indicator — receives this client and
 * keeps working, while product code gets its own models fully typed.
 *
 * One client, one connection pool, both sets of models.
 */
@Injectable()
export class AppPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    config: AppConfig,
    private readonly logger?: Logger,
  ) {
    super({
      datasources: { db: { url: config.database.url } },
      errorFormat: config.isProduction ? 'minimal' : 'pretty',
    });
  }

  /**
   * Opens the pool eagerly, but does not fail startup if the database is
   * unreachable — that is what `/ready` reports. Crashing here would mean a
   * database restart takes every application instance with it.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      this.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'database unavailable at startup; serving readiness failures until it returns',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
