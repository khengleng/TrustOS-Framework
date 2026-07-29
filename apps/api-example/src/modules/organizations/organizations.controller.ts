import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@trustos/auth';
import { AllowAnyAuthenticated, PERMISSIONS, RequirePermissions } from '@trustos/rbac';
import { NoTenantRequired, OrganizationId } from '@trustos/tenancy';
import type {
  ActorContext,
  OrganizationMemberSummary,
  OrganizationSummary,
  RoleSummary,
} from '@trustos/shared-types';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { OrganizationsService } from './organizations.service';
import {
  AssignRoleDto,
  CreateOrganizationDto,
  InviteMemberDto,
  assignRoleSchema,
  createOrganizationSchema,
  inviteMemberSchema,
} from './organizations.dto';

/**
 * Organization endpoints.
 *
 * The routes carry `:organizationId` for readability and for REST convention,
 * but the value is *not* what scopes the query — `TenantGuard` derives that
 * from the access token and rejects the request if the path disagrees. The
 * handler receives the verified id through `@OrganizationId()`.
 */
@ApiTags('organizations')
@ApiBearerAuth('access-token')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  // Any authenticated user may found an organization; they cannot hold an
  // organization permission before one exists.
  @AllowAnyAuthenticated()
  @NoTenantRequired()
  @ApiOperation({ summary: 'Create an organization and become its owner' })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiCreatedResponse({ description: 'The new organization.' })
  create(
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationDto,
  ): Promise<OrganizationSummary> {
    return this.organizations.create(
      { name: body.name, ...(body.slug ? { slug: body.slug } : {}) },
      actor.userId,
    );
  }

  @Get(':organizationId')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ.key)
  @ApiOperation({ summary: 'Read the current organization' })
  find(@OrganizationId() organizationId: string): Promise<OrganizationSummary> {
    return this.organizations.findById(organizationId);
  }

  @Get(':organizationId/members')
  @RequirePermissions(PERMISSIONS.MEMBER_READ.key)
  @ApiOperation({ summary: 'List organization members' })
  @ApiOkResponse({ description: 'Members with their assigned roles.' })
  listMembers(@OrganizationId() organizationId: string): Promise<OrganizationMemberSummary[]> {
    return this.organizations.listMembers(organizationId);
  }

  @Post(':organizationId/members')
  @RequirePermissions(PERMISSIONS.MEMBER_INVITE.key)
  @ApiOperation({ summary: 'Invite a member' })
  @ApiBody({ type: InviteMemberDto })
  invite(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberDto,
  ): Promise<OrganizationMemberSummary> {
    return this.organizations.invite(
      organizationId,
      { email: body.email, ...(body.roleName ? { roleName: body.roleName } : {}) },
      actor,
    );
  }

  @Put(':organizationId/members/:memberId/role')
  @RequirePermissions(PERMISSIONS.ROLE_ASSIGN.key)
  @ApiOperation({
    summary: 'Assign a role to a member',
    description:
      'The caller may only grant roles their own role permits — an administrator cannot ' +
      'promote anyone to organization_owner.',
  })
  @ApiBody({ type: AssignRoleDto })
  assignRole(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('memberId') memberId: string,
    @Body(new ZodValidationPipe(assignRoleSchema)) body: AssignRoleDto,
  ): Promise<OrganizationMemberSummary> {
    return this.organizations.assignRole(organizationId, memberId, body.roleName, actor);
  }

  @Get(':organizationId/roles')
  @RequirePermissions(PERMISSIONS.ROLE_READ.key)
  @ApiOperation({ summary: 'List assignable roles' })
  listRoles(@OrganizationId() organizationId: string): Promise<RoleSummary[]> {
    return this.organizations.listRoles(organizationId);
  }
}
