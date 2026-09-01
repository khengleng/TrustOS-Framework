import { Prisma, type PrismaClient } from '@trustsystem/database';
import type { ActorType } from '@trustsystem/shared-types';
import type { AuditQuery, AuditQueryResult, AuditRecord, AuditSink } from './audit-record';

/**
 * PostgreSQL-backed audit sink.
 *
 * Only INSERT and SELECT are implemented, which is also how the database
 * grants should be configured in production:
 *
 *   GRANT SELECT, INSERT ON "AuditLog" TO trustos_app;
 *   REVOKE UPDATE, DELETE ON "AuditLog" FROM trustos_app;
 *
 * Application-level immutability is a convention; the grant is the control.
 */
export class PrismaAuditSink implements AuditSink {
  constructor(private readonly prisma: PrismaClient) {}

  async append(record: AuditRecord): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action: record.action,
        entityType: record.entityType,
        entityId: record.entityId,
        actorId: record.actorId,
        actorType: record.actorType,
        organizationId: record.organizationId,
        before: toJson(record.before),
        after: toJson(record.after),
        metadata: toJson(record.metadata),
        requestId: record.requestId,
        ipAddress: record.ipAddress,
        userAgent: record.userAgent,
        createdAt: record.occurredAt,
      },
    });
  }

  /**
   * Reads the trail.
   *
   * `organizationId` is applied unconditionally unless it is explicitly null
   * (platform-wide read, restricted to super admins by the calling route), so
   * a caller cannot page through another organization's history.
   */
  async query(query: AuditQuery): Promise<AuditQueryResult> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.organizationId !== null ? { organizationId: query.organizationId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.actorType ? { actorType: query.actorType } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [rows, totalItems] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      totalItems,
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actorId: row.actorId,
        // Narrowed rather than cast: the column is a plain string, and a value
        // outside the union means somebody wrote to the table by hand.
        actorType: toActorType(row.actorType),
        organizationId: row.organizationId,
        before: row.before,
        after: row.after,
        metadata: row.metadata,
        requestId: row.requestId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        occurredAt: row.createdAt,
        createdAt: row.createdAt,
      })),
    };
  }
}

const ACTOR_TYPES: ActorType[] = ['user', 'service_account', 'api_key', 'system'];

function toActorType(value: string | null): ActorType | null {
  if (value === null) return null;
  return ACTOR_TYPES.includes(value as ActorType) ? (value as ActorType) : null;
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}
