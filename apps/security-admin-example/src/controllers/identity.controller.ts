import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authorize } from '@trustos/authorization/nest';
import { CurrentUser } from '@trustos/auth';
import { HumanActorsOnly, RequireAuthenticationLevel } from '@trustos/identity/nest';
import type { IdentityProvider } from '@trustos/identity';
import { PERMISSIONS, RequirePermissions } from '@trustos/rbac';
import { securityPolicySummary, type SecurityPolicy } from '@trustos/security-policy';
import type { ActorContext } from '@trustos/shared-types';
import { IDENTITY_PROVIDER, SECURITY_POLICY } from '../tokens';

/**
 * Identity provider status and the effective security policy.
 *
 * Every value returned here is either a limit, a boolean or an issuer URL. There is
 * no route that returns a secret, because `securityPolicySummary` is the only
 * projection of the policy this controller can reach, and it is built by listing the
 * fields that are safe rather than by removing the ones that are not — a summary that
 * enumerates safe fields cannot start leaking when a new setting is added.
 */
@ApiTags('security/identity')
@ApiBearerAuth('access-token')
@Controller('security/identity')
export class IdentityController {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(SECURITY_POLICY) private readonly policy: SecurityPolicy,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'The normalized actor for this request' })
  @ApiOkResponse({
    description: 'What every guard and audit record in the framework sees, whoever the caller is.',
  })
  me(@CurrentUser() actor: ActorContext) {
    // Deliberately the whole actor: it holds no credential, and being able to see
    // exactly what the server believes about you is how an integration debugs a 403
    // without anyone reading tokens out of a log.
    return {
      actorType: actor.actorType,
      userId: actor.userId,
      email: actor.email,
      organizationId: actor.organizationId,
      roles: actor.roles,
      permissions: actor.permissions,
      scopes: actor.scopes ?? null,
      isSuperAdmin: actor.isSuperAdmin,
      provider: actor.provider ?? null,
      sessionId: actor.sessionId ?? null,
      authentication: actor.authentication ?? null,
    };
  }

  @Get('provider')
  @HumanActorsOnly()
  @RequirePermissions(PERMISSIONS.SECURITY_READ.key)
  @Authorize('security.read')
  @ApiOperation({ summary: 'Identity provider health' })
  @ApiOkResponse({
    description:
      'Reachability and the configured issuer. Never a client secret, and never a signing key.',
  })
  async providerStatus() {
    const health = await this.provider.health();
    return {
      provider: this.provider.id,
      kind: this.provider.kind,
      supportsPasswordAuthentication: this.provider.supportsPasswordAuthentication,
      // Whether "sign out everywhere" actually reaches the provider. An operator
      // needs to know before an incident, not during one.
      supportsCentralSessionRevocation: this.provider.supportsCentralSessionRevocation,
      ...health,
    };
  }

  @Get('policy')
  @HumanActorsOnly()
  // The effective policy tells an attacker exactly how long a stolen token stays
  // useful and how many attempts they get, so reading it needs a strong session as
  // well as the permission.
  @RequireAuthenticationLevel('high')
  @RequirePermissions(PERMISSIONS.SECURITY_READ.key)
  @Authorize('security.read')
  @ApiOperation({ summary: 'The effective security policy, as limits only' })
  policySummary() {
    return securityPolicySummary(this.policy);
  }
}
