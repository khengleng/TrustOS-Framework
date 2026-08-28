import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyService, type ApiKeyMetadata } from '@trustos/api-keys';
import { Authorize } from '@trustos/authorization/nest';
import { HumanActorsOnly } from '@trustos/identity/nest';
import { PERMISSIONS, RequirePermissions } from '@trustos/rbac';
import { CurrentUser } from '@trustos/auth';
import { OrganizationId } from '@trustos/tenancy';
import type { ActorContext } from '@trustos/shared-types';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { API_KEY_SERVICE } from '../tokens';

const createSchema = z.object({
  name: z.string().min(3).max(80),
  description: z.string().max(500).optional(),
  scopes: z.array(z.string().min(1).max(64)).min(1).max(32),
  ipAllowlist: z.array(z.string().min(1).max(64)).max(20).optional(),
  lifetimeSeconds: z.number().int().min(3600).optional(),
});

const revokeSchema = z.object({ reason: z.string().min(3).max(200) });

/**
 * API key administration.
 *
 * Two properties this controller exists to demonstrate:
 *
 *   * the plaintext key appears in exactly two responses — create and rotate —
 *     and in no other code path, because nothing else can reconstruct it;
 *   * every route is `@HumanActorsOnly()`. An API key that can mint API keys is a
 *     privilege-escalation primitive: one leaked credential becomes a permanent
 *     foothold that survives its own revocation.
 */
@ApiTags('security/api-keys')
@ApiBearerAuth('access-token')
@HumanActorsOnly()
@Controller('security/api-keys')
export class ApiKeyController {
  constructor(@Inject(API_KEY_SERVICE) private readonly keys: ApiKeyService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.API_KEY_READ.key)
  @Authorize('security.api_key.read', 'ApiKey')
  @ApiOperation({ summary: 'List this organization’s API keys' })
  @ApiOkResponse({ description: 'Prefix and metadata only. The key value is not stored.' })
  list(@OrganizationId() organizationId: string): Promise<ApiKeyMetadata[]> {
    return this.keys.list(organizationId);
  }

  @Get(':id/usage')
  @RequirePermissions(PERMISSIONS.API_KEY_READ.key)
  @Authorize('security.api_key.read', 'ApiKey')
  @ApiOperation({ summary: 'When and from where a key was last used' })
  usage(@OrganizationId() organizationId: string, @Param('id') id: string) {
    // The first question in a leak investigation, and answerable without the value.
    return this.keys.usage(id, organizationId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.API_KEY_CREATE.key)
  @Authorize('security.api_key.create', 'ApiKey')
  @ApiOperation({ summary: 'Create an API key' })
  @ApiOkResponse({ description: 'The only response that contains the key value.' })
  async create(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ) {
    const created = await this.keys.create({
      organizationId,
      name: body.name,
      scopes: body.scopes,
      createdById: actor.userId,
      ...(body.description ? { description: body.description } : {}),
      ...(body.ipAllowlist ? { ipAllowlist: body.ipAllowlist } : {}),
      ...(body.lifetimeSeconds ? { lifetimeSeconds: body.lifetimeSeconds } : {}),
    });

    return {
      key: created.key,
      metadata: created.metadata,
      warning:
        'Store this key now. It is hashed on the server and cannot be shown again; if it is lost, rotate the key.',
    };
  }

  @Post(':id/rotate')
  @RequirePermissions(PERMISSIONS.API_KEY_ROTATE.key)
  @Authorize('security.api_key.rotate', 'ApiKey')
  @ApiOperation({ summary: 'Rotate a key, leaving the old one valid for a grace period' })
  async rotate(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Param('id') id: string,
  ) {
    const rotated = await this.keys.rotate(id, organizationId, actor.userId);

    return {
      key: rotated.key,
      metadata: rotated.metadata,
      // Stated in the response because the caller has to deploy the new key before
      // the window closes, and a grace period nobody was told about is an outage.
      warning:
        'The previous key keeps working for the grace period recorded on the rotated key. Deploy this one, verify traffic, then revoke the old key.',
    };
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.API_KEY_REVOKE.key)
  @Authorize('security.api_key.revoke', 'ApiKey')
  @ApiOperation({ summary: 'Revoke a key immediately' })
  revoke(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(revokeSchema)) body: z.infer<typeof revokeSchema>,
  ): Promise<ApiKeyMetadata> {
    // Idempotent in the service, so the second click during an incident is not an error.
    return this.keys.revoke(id, organizationId, body.reason, actor.userId);
  }
}
