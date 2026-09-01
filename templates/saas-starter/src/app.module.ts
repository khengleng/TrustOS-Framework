import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuditService, PrismaAuditSink } from '@trustsystem/audit';
import { JwtAuthGuard, TokenService } from '@trustsystem/auth';
import type { AppConfig } from '@trustsystem/config';
import { DatabaseModule, PrismaService, checkDatabaseConnection } from '@trustsystem/database';
import { setRequestActor, type Logger } from '@trustsystem/logging';
import {
  ObservabilityModule,
  databaseHealthIndicator,
  type MetricsRecorder,
} from '@trustsystem/observability';
import { PermissionsGuard } from '@trustsystem/rbac';
import { TenantGuard } from '@trustsystem/tenancy';
import { WidgetsModule } from './modules/widgets/widgets.module';
import { APP_CONFIG_TOKEN, APP_LOGGER, APP_METRICS, AUDIT_SERVICE } from './tokens';

export interface AppModuleOptions {
  config: AppConfig;
  logger: Logger;
  metrics: MetricsRecorder;
}

/**
 * Composition root for a new product.
 *
 * What to change when you copy this template:
 *   * add your feature modules to `imports`
 *   * nothing else
 *
 * The three global guards and their order are framework policy. A product that
 * changes them is opting out of the security model, and that is a decision for
 * a security review, not a module file.
 */
@Global()
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config, logger, metrics } = options;

    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot({ config, logger }),
        ObservabilityModule.forRootAsync({
          config,
          inject: [PrismaService],
          useFactory: ((prisma: PrismaService) => ({
            indicators: [databaseHealthIndicator(() => checkDatabaseConnection(prisma))],
            metrics,
          })) as never,
        }),

        // --- your product modules go here -----------------------------------
        WidgetsModule,
      ],
      providers: [
        { provide: APP_CONFIG_TOKEN, useValue: config },
        { provide: APP_LOGGER, useValue: logger },
        { provide: APP_METRICS, useValue: metrics },
        { provide: TokenService, useValue: new TokenService(config) },
        {
          provide: AUDIT_SERVICE,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) =>
            new AuditService({ sink: new PrismaAuditSink(prisma), logger }),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector, TokenService],
          useFactory: (reflector: Reflector, tokens: TokenService) =>
            new JwtAuthGuard(reflector, {
              tokens,
              onActorResolved: (actor) => setRequestActor(actor),
            }),
        },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
      exports: [APP_CONFIG_TOKEN, APP_LOGGER, APP_METRICS, AUDIT_SERVICE, TokenService],
    };
  }
}
