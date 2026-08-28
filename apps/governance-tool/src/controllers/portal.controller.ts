import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@trustos/auth';
import type { Environment } from '@trustos/governance-tool-core';
import { NoTenantRequired } from '@trustos/tenancy';
import { GATEWAY_ENVIRONMENT, PORTAL_CONFIG } from '../tokens';

/** What the browser needs before it can begin a login. */
export interface PortalConfig {
  issuerUrl: string;
  clientId: string;
}

/**
 * The one thing the portal must read before it has a token.
 *
 * A browser cannot start an authorization-code flow without knowing where to send the
 * user and which client it is, and it cannot learn either from an endpoint that requires
 * the token it is trying to obtain. So this route is public — deliberately, and narrowly.
 *
 * Nothing here is a secret. The issuer URL is in every redirect the user's browser makes
 * and `trustos-web` is a *public* OIDC client, which by definition holds no secret; PKCE
 * is what makes that safe. The alternative — compiling the issuer into the JavaScript —
 * would put an environment-specific value in a static asset and give DEV a build that
 * points at production's identity provider.
 *
 * What is deliberately not here: anything about what exists inside the platform. The
 * catalog, the consoles and the resources all stay behind authentication.
 */
@ApiTags('portal')
@Controller('portal')
export class PortalController {
  constructor(
    @Inject(PORTAL_CONFIG) private readonly portal: PortalConfig | null,
    @Inject(GATEWAY_ENVIRONMENT) private readonly environment: Environment,
  ) {}

  @Get('config')
  @Public()
  @NoTenantRequired()
  @ApiOperation({ summary: 'Where the browser should send the user to sign in' })
  @ApiOkResponse({ description: 'Issuer, client id and the environment this gateway serves.' })
  config(): {
    environment: Environment;
    identity: PortalConfig | null;
  } {
    return {
      environment: this.environment,
      /*
       * Null when the deployment runs without OIDC. The portal renders an explanation
       * rather than a broken sign-in button — a login that cannot work should say so
       * instead of failing at the redirect.
       */
      identity: this.portal,
    };
  }
}
