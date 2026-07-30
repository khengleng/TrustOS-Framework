import { Body, Controller, Delete, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { ApiError } from '@trustos/errors';
import { HumanActorsOnly } from '@trustos/identity/nest';
import { PERMISSIONS, RequirePermissions } from '@trustos/rbac';
import { SessionService, type SessionSummary } from '@trustos/session-security';
import { OrganizationId } from '@trustos/tenancy';
import type { ActorContext } from '@trustos/shared-types';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { SESSION_SERVICE } from '../tokens';

/**
 * A closed set, not free text.
 *
 * The reason is written into the session record and into a security event, and it is
 * what somebody reads six months later when asking why a session ended. Free text
 * would make that column unqueryable; a wider set would let a caller invent
 * `reuse_detected`, which the framework reserves for something it detected itself.
 */
const revokeSchema = z.object({
  reason: z.enum(['administrative', 'suspicious']).default('administrative'),
});

/**
 * Session and device administration.
 *
 * A device list is a security feature only if the person reading it can act on it,
 * so listing and revoking sit on the same controller. Everything here reports
 * coarse device labels and never a token: the store holds hashes, so there is no
 * token value to expose even by accident.
 */
@ApiTags('security/sessions')
@ApiBearerAuth('access-token')
@HumanActorsOnly()
@Controller('security/sessions')
export class SessionController {
  constructor(@Inject(SESSION_SERVICE) private readonly sessions: SessionService) {}

  @Get('mine')
  @ApiOperation({ summary: 'The signed-in user’s own devices' })
  @ApiOkResponse({ description: 'One entry per session; the current one is flagged.' })
  listMine(@CurrentUser() actor: ActorContext): Promise<SessionSummary[]> {
    // No permission required: a person may always see their own sessions, and the
    // user id comes from the verified token rather than from a parameter.
    return this.sessions.list(actor.userId, actor.sessionId ?? null);
  }

  @Delete('mine/:id')
  @ApiOperation({ summary: 'Sign one of my own devices out' })
  async revokeMine(
    @CurrentUser() actor: ActorContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(revokeSchema)) body: z.infer<typeof revokeSchema>,
  ) {
    // Ownership checked here rather than trusted from the path: without this, the
    // route is "revoke any session by id" for every authenticated user.
    const own = await this.sessions.list(actor.userId);
    if (!own.some((session) => session.id === id)) {
      // Same response as a session that does not exist, so the endpoint does not
      // confirm the existence of somebody else's session.
      throw ApiError.notFound();
    }

    await this.sessions.revoke(id, body.reason, { userId: actor.userId, actorType: 'user' });
    return { revoked: true };
  }

  @Delete('mine')
  @ApiOperation({ summary: 'Sign me out everywhere' })
  async revokeAllMine(@CurrentUser() actor: ActorContext) {
    const count = await this.sessions.revokeAll(actor.userId, 'logout_all', {
      userId: actor.userId,
      actorType: 'user',
    });
    return { revokedSessions: count };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.SESSION_READ.key)
  @Authorize('security.session.read', 'UserSession')
  @ApiOperation({ summary: 'A member’s sessions, for an administrator' })
  listForUser(
    @Query('userId') userId: string,
    @OrganizationId() organizationId: string,
  ): Promise<SessionSummary[]> {
    // The organization comes from the caller's own verified token, never from a query
    // parameter, and it is passed as a filter — so learning another organization's
    // user id buys an administrator nothing.
    return this.sessions.list(userId, null, organizationId);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.SESSION_REVOKE.key)
  @Authorize('security.session.revoke', 'UserSession')
  @ApiOperation({ summary: 'Revoke a member’s session' })
  async revoke(
    @CurrentUser() actor: ActorContext,
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(revokeSchema)) body: z.infer<typeof revokeSchema>,
  ) {
    await this.sessions.revoke(
      id,
      body.reason,
      { userId: actor.userId, actorType: 'user' },
      organizationId,
    );
    return { revoked: true };
  }
}
