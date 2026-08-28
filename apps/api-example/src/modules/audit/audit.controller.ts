import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from '@trustos/audit';
import { PERMISSIONS, RequirePermissions } from '@trustos/rbac';
import { OrganizationId } from '@trustos/tenancy';
import { buildPageMeta, type AuditLogEntry, type Paginated } from '@trustos/shared-types';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { AUDIT_SERVICE } from '../../tokens';

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  action: z.string().min(1).max(120).optional(),
  actorId: z.string().min(1).max(64).optional(),
  entityType: z.string().min(1).max(120).optional(),
  entityId: z.string().min(1).max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

type AuditQueryInput = z.infer<typeof auditQuerySchema>;

/**
 * Audit trail retrieval.
 *
 * Two controls apply, and both are server-side:
 *   * `audit.read` — held by organization_owner, administrator and auditor.
 *   * the organization scope, taken from the token by `TenantGuard`, so a
 *     reader sees their own organization's history and no one else's.
 */
@ApiTags('audit')
@ApiBearerAuth('access-token')
@Controller('audit-logs')
export class AuditController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_READ.key)
  @ApiOperation({ summary: 'Read the organization audit trail' })
  @ApiOkResponse({ description: 'A page of audit records, newest first.' })
  async list(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQueryInput,
  ): Promise<Paginated<AuditLogEntry>> {
    const result = await this.audit.query({
      organizationId,
      page: query.page,
      pageSize: query.pageSize,
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    });

    return {
      items: result.items.map((record) => ({
        id: record.id,
        action: record.action,
        entityType: record.entityType,
        entityId: record.entityId,
        actorId: record.actorId,
        organizationId: record.organizationId,
        before: record.before,
        after: record.after,
        requestId: record.requestId,
        ipAddress: record.ipAddress,
        userAgent: record.userAgent,
        createdAt: record.createdAt.toISOString(),
      })),
      meta: buildPageMeta({ page: query.page, pageSize: query.pageSize }, result.totalItems),
    };
  }
}
