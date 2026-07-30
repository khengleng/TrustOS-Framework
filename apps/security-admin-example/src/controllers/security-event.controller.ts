import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { PrismaService } from '@trustos/database';
import { HumanActorsOnly } from '@trustos/identity/nest';
import { PERMISSIONS, RequirePermissions } from '@trustos/rbac';
import { SECURITY_EVENT_TYPES, type SecuritySeverity } from '@trustos/security-events';
import { redactSecrets } from '@trustos/security-policy';
import { OrganizationId } from '@trustos/tenancy';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(SECURITY_EVENT_TYPES).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * The security event trail.
 *
 * Distinct from the audit trail on purpose. The audit trail answers "who changed
 * this record"; this answers "what was attempted and refused" — failed logins,
 * blocked cross-tenant reads, refresh reuse, rate limiting. Most of its entries have
 * no actor at all, which is exactly what makes them useful.
 *
 * Two boundaries hold here:
 *
 *   * the organization filter comes from the caller's verified token, so this is a
 *     view of one organization's events even though the table is global;
 *   * events with no organization — a failed login for an unrecognised address, for
 *     instance — are never returned to a customer, because they belong to whoever
 *     operates the platform, and one of them naming a real address would tell a
 *     tenant which of their people is being targeted from outside.
 *
 * The context object is re-redacted on the way out. It was already redacted before it
 * was stored, so this is the second of two passes; the cost is one walk of a small
 * object, and the alternative is that a single future writer who bypasses the emitter
 * turns this endpoint into a credential viewer.
 */
@ApiTags('security/events')
@ApiBearerAuth('access-token')
@HumanActorsOnly()
@Controller('security/events')
export class SecurityEventController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SECURITY_EVENT_READ.key)
  @Authorize('security.event.read', 'SecurityEvent')
  @ApiOperation({ summary: 'Recent security events for this organization' })
  @ApiOkResponse({ description: 'Newest first. Secret-named context fields are redacted.' })
  async list(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(querySchema)) query: z.infer<typeof querySchema>,
  ) {
    const where = {
      organizationId,
      ...(query.type ? { type: query.type } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.from || query.to
        ? {
            occurredAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.securityEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.securityEvent.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        severity: row.severity as SecuritySeverity,
        result: row.result,
        reason: row.reason,
        actorId: row.actorId,
        actorType: row.actorType,
        ipAddress: row.ipAddress,
        provider: row.provider,
        risk: row.risk,
        context: row.context ? redactSecrets(row.context as Record<string, unknown>) : null,
        occurredAt: row.occurredAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.SECURITY_EVENT_READ.key)
  @Authorize('security.event.read', 'SecurityEvent')
  @ApiOperation({ summary: 'Event counts by severity, for a dashboard tile' })
  async summary(@OrganizationId() organizationId: string) {
    const grouped = await this.prisma.securityEvent.groupBy({
      by: ['severity'],
      where: { organizationId },
      _count: { _all: true },
    });

    const counts: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    for (const group of grouped) {
      counts[group.severity] = group._count._all;
    }

    return counts;
  }
}
