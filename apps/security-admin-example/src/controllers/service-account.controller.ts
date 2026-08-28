import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { ApiError } from '@trustos/errors';
import { HumanActorsOnly } from '@trustos/identity/nest';
import { PERMISSIONS, RequirePermissions } from '@trustos/rbac';
import { ServiceAccountService, type ServiceAccountMetadata } from '@trustos/service-accounts';
import type { ActorContext } from '@trustos/shared-types';
import { OrganizationId } from '@trustos/tenancy';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { SERVICE_ACCOUNT_SERVICE } from '../tokens';

const createSchema = z
  .object({
    name: z.string().min(3).max(80),
    description: z.string().max(500).optional(),
    scopes: z.array(z.string().min(1).max(64)).min(1).max(32),
    roles: z.array(z.string().min(1).max(64)).max(8).optional(),
    /** Recommended in production: the provider holds the secret, the framework holds none. */
    oidcClientId: z.string().min(1).max(120).optional(),
    issueCredential: z.boolean().default(false),
    lifetimeSeconds: z.number().int().min(3600).optional(),
  })
  .refine((value) => Boolean(value.oidcClientId) !== value.issueCredential, {
    message: 'Choose exactly one credential type: an OIDC client id, or a local credential.',
  });

const disableSchema = z.object({ reason: z.string().min(3).max(200) });

/**
 * Service account administration.
 *
 * The point of the resource is that an integration gets its own identity instead of
 * borrowing a person's: when the integration is decommissioned, one account is
 * disabled and nobody's login breaks, and every record it wrote still names a machine.
 *
 * Human actors only, and for the same reason as the API key routes: a machine that
 * can create machines is an escalation path that outlives its own credential.
 */
@ApiTags('security/service-accounts')
@ApiBearerAuth('access-token')
@HumanActorsOnly()
@Controller('security/service-accounts')
export class ServiceAccountController {
  constructor(@Inject(SERVICE_ACCOUNT_SERVICE) private readonly accounts: ServiceAccountService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SERVICE_ACCOUNT_READ.key)
  @Authorize('security.service_account.read', 'ServiceAccount')
  @ApiOperation({ summary: 'List this organization’s service accounts' })
  @ApiOkResponse({ description: 'Metadata and credential prefix. Never a credential value.' })
  list(@OrganizationId() organizationId: string): Promise<ServiceAccountMetadata[]> {
    return this.accounts.list(organizationId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.SERVICE_ACCOUNT_CREATE.key)
  @Authorize('security.service_account.create', 'ServiceAccount')
  @ApiOperation({ summary: 'Create a service account' })
  async create(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    const created = await this.accounts.create({
      organizationId,
      name: body.name,
      scopes: body.scopes,
      issueCredential: body.issueCredential,
      createdById: actor.userId,
      ...(body.description ? { description: body.description } : {}),
      ...(body.roles ? { roles: body.roles } : {}),
      ...(body.oidcClientId ? { oidcClientId: body.oidcClientId } : {}),
      ...(body.lifetimeSeconds ? { lifetimeSeconds: body.lifetimeSeconds } : {}),
    });

    return {
      metadata: created.metadata,
      ...(created.credential
        ? {
            credential: created.credential,
            warning:
              'Store this credential now. It is hashed on the server and cannot be shown again.',
          }
        : {}),
    };
  }

  @Post(':id/rotate')
  @RequirePermissions(PERMISSIONS.SERVICE_ACCOUNT_MANAGE.key)
  @Authorize('security.service_account.manage', 'ServiceAccount')
  @ApiOperation({ summary: 'Rotate a local credential' })
  async rotate(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Param('id') id: string,
  ) {
    await this.assertBelongsToOrganization(id, organizationId);
    const rotated = await this.accounts.rotateCredential(id, actor.userId);

    return {
      metadata: rotated.metadata,
      credential: rotated.credential,
      // No grace period on purpose: two valid machine credentials for an overlapping
      // window is a second way in for as long as the window lasts. Schedule the
      // rotation, deploy the new value, then let the integration reconnect.
      warning:
        'The previous credential stopped working immediately. Deploy this value before the next run.',
    };
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.SERVICE_ACCOUNT_MANAGE.key)
  @Authorize('security.service_account.manage', 'ServiceAccount')
  @ApiOperation({ summary: 'Disable a service account' })
  @ApiOkResponse({ description: 'Disabled, not deleted, so its audit records stay resolvable.' })
  async disable(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(disableSchema)) body: z.infer<typeof disableSchema>,
  ): Promise<ServiceAccountMetadata> {
    await this.assertBelongsToOrganization(id, organizationId);
    return this.accounts.disable(id, body.reason, actor.userId);
  }

  /**
   * Service accounts are looked up by id alone, because authentication has to find
   * one before any organization is known. Every administrative route therefore has
   * to re-establish the tenant boundary itself.
   */
  private async assertBelongsToOrganization(id: string, organizationId: string): Promise<void> {
    const account = await this.accounts.find(id);
    if (account.organizationId !== organizationId) {
      // Not found rather than forbidden, so the response does not confirm that an
      // account with this id exists elsewhere.
      throw ApiError.notFound();
    }
  }
}
