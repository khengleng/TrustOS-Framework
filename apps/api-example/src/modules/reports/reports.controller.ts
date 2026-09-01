import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MembershipStatus, PrismaService } from '@trustsystem/database';
import { PERMISSIONS, RequirePermissions } from '@trustsystem/rbac';
import { OrganizationId, requireOrganizationId } from '@trustsystem/tenancy';

/**
 * A protected, tenant-scoped endpoint.
 *
 * This is the shape a product feature takes: a permission on the route, the
 * organization taken from `@OrganizationId()`, and every query filtered by it.
 * The assertion at the end is not defensive programming for its own sake — it
 * is a cheap check that the value the handler used and the value the guard
 * established are the same one.
 */
@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ.key)
  @ApiOperation({ summary: 'Membership summary for the current organization' })
  async summary(@OrganizationId() organizationId: string): Promise<{
    organizationId: string;
    activeMembers: number;
    invitedMembers: number;
    suspendedMembers: number;
  }> {
    if (organizationId !== requireOrganizationId()) {
      // Would mean the handler and the guard disagree about the tenant.
      throw new Error('Tenant context mismatch');
    }

    const [activeMembers, invitedMembers, suspendedMembers] = await Promise.all([
      this.prisma.organizationMember.count({
        where: { organizationId, deletedAt: null, status: MembershipStatus.ACTIVE },
      }),
      this.prisma.organizationMember.count({
        where: { organizationId, deletedAt: null, status: MembershipStatus.INVITED },
      }),
      this.prisma.organizationMember.count({
        where: { organizationId, deletedAt: null, status: MembershipStatus.SUSPENDED },
      }),
    ]);

    return { organizationId, activeMembers, invitedMembers, suspendedMembers };
  }
}
