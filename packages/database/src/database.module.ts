import { DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '@trustos/config';
import { PrismaService } from './prisma.service';
import { APP_CONFIG, DATABASE_LOGGER } from './tokens';
import type { DatabaseLogger } from './prisma-client';

export interface DatabaseModuleOptions {
  config: AppConfig;
  logger?: DatabaseLogger;
}

/**
 * Provides the single `PrismaService` instance for the process.
 *
 * Global on purpose: a second connection pool per feature module is a common
 * way to exhaust Postgres connections on a small Railway plan.
 */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: DATABASE_LOGGER, useValue: options.logger ?? null },
        PrismaService,
      ],
      exports: [PrismaService, APP_CONFIG],
    };
  }
}
