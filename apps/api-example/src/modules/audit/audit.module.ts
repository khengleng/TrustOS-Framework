import { Global, Module } from '@nestjs/common';
import { AuditService, PrismaAuditSink } from '@trustsystem/audit';
import { PrismaService } from '@trustsystem/database';
import type { Logger } from '@trustsystem/logging';
import { APP_LOGGER, AUDIT_SERVICE } from '../../tokens';
import { AuditController } from './audit.controller';

/**
 * Global so any module can record an audit entry without importing this one.
 *
 * Audit is cross-cutting in the same way logging is: making each feature
 * module declare a dependency on it adds friction to exactly the thing that
 * must never be skipped.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    {
      provide: AUDIT_SERVICE,
      inject: [PrismaService, APP_LOGGER],
      useFactory: (prisma: PrismaService, logger: Logger) =>
        new AuditService({ sink: new PrismaAuditSink(prisma), logger }),
    },
  ],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
