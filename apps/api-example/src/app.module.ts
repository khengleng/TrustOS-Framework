import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { AppConfig } from '@trustos/config';
import { DatabaseModule, PrismaService, checkDatabaseConnection } from '@trustos/database';
import { JwtAuthGuard, TokenService } from '@trustos/auth';
import { PermissionsGuard } from '@trustos/rbac';
import { TenantGuard } from '@trustos/tenancy';
import {
  ObservabilityModule,
  databaseHealthIndicator,
  type MetricsRecorder,
} from '@trustos/observability';
import { setRequestActor, type Logger } from '@trustos/logging';
import { CoreModule } from './core/core.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ReportsModule } from './modules/reports/reports.module';

export interface AppModuleOptions {
  config: AppConfig;
  logger: Logger;
  metrics: MetricsRecorder;
}

/**
 * Composition root.
 *
 * The guard order below is the security model of the whole application, so it
 * is worth reading as a sequence:
 *
 *   JwtAuthGuard      — who is calling?          (sets request.actor)
 *   TenantGuard       — whose data may they see? (sets request.organizationId)
 *   PermissionsGuard  — may they do this?        (deny-by-default)
 *
 * Nest applies APP_GUARD providers in registration order, so this array *is*
 * the order. Reordering it changes what happens on an unauthenticated request
 * to a tenant-scoped route.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config, logger, metrics } = options;

    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot({ config, logger, metrics }),
        DatabaseModule.forRoot({ config, logger }),
        ObservabilityModule.forRootAsync({
          config,
          inject: [PrismaService],
          useFactory: ((prisma: PrismaService) => ({
            indicators: [databaseHealthIndicator(() => checkDatabaseConnection(prisma))],
            metrics,
          })) as never,
        }),
        AuthModule.forRoot(config),
        OrganizationsModule,
        AuditModule,
        ReportsModule,
      ],
      providers: [
        {
          provide: APP_GUARD,
          inject: [Reflector, TokenService],
          useFactory: (reflector: Reflector, tokens: TokenService) =>
            new JwtAuthGuard(reflector, {
              tokens,
              // Enriches every subsequent log line and audit record with the
              // actor, without each call site passing it along.
              onActorResolved: (actor) => setRequestActor(actor),
            }),
        },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
    };
  }
}
