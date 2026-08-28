import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';

/**
 * Exposes the audit trail for reading.
 *
 * The AuditService itself is provided globally by AppModule, because writing
 * an audit record is cross-cutting: making every feature module declare a
 * dependency on it adds friction to exactly the thing that must never be
 * skipped.
 */
@Module({ controllers: [AuditController] })
export class AuditModule {}
