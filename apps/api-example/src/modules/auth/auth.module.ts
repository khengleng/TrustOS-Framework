import { DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from '@trustos/config';
import { PrismaService } from '@trustos/database';
import {
  AuthService,
  PrismaAuthUserStore,
  PrismaMembershipResolver,
  PrismaRefreshTokenStore,
  TokenService,
} from '@trustos/auth';
import type { AuditService } from '@trustos/audit';
import { AUDIT_SERVICE, AUTH_SERVICE } from '../../tokens';
import { AuthAuditBridge } from './auth-audit.bridge';
import { AuthController } from './auth.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

/**
 * Wires the framework's `AuthService` to this application's storage.
 *
 * All the substitutable parts are visible in one factory: swap
 * `PrismaAuthUserStore` for another implementation and nothing else changes.
 */
@Module({})
export class AuthModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AuthModule,
      imports: [OrganizationsModule],
      controllers: [AuthController],
      providers: [
        { provide: TokenService, useValue: new TokenService(config) },
        {
          provide: AUTH_SERVICE,
          inject: [PrismaService, AUDIT_SERVICE],
          useFactory: (prisma: PrismaService, audit: AuditService) =>
            new AuthService({
              config,
              users: new PrismaAuthUserStore(prisma),
              refreshTokens: new PrismaRefreshTokenStore(prisma),
              memberships: new PrismaMembershipResolver(prisma),
              events: new AuthAuditBridge(audit),
            }),
        },
      ],
      exports: [AUTH_SERVICE, TokenService],
    };
  }
}
