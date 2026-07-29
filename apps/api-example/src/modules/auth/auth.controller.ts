import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService, CurrentUser, Public } from '@trustos/auth';
import { AllowAnyAuthenticated } from '@trustos/rbac';
import { NoTenantRequired } from '@trustos/tenancy';
import type { ActorContext, AuthResponse } from '@trustos/shared-types';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { AUTH_SERVICE } from '../../tokens';
import { currentRequestMeta } from '../../common/request-meta';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  LoginDto,
  LogoutDto,
  RefreshDto,
  RegisterDto,
  loginSchema,
  refreshSchema,
  registerSchema,
} from './auth.dto';

/**
 * Authentication endpoints.
 *
 * Everything before a session exists is `@Public()`. Note that `/refresh` and
 * `/logout` are public by necessity — they are called precisely when the
 * access token has expired — and are protected by the refresh token itself.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    private readonly organizations: OrganizationsService,
  ) {}

  @Post('register')
  @Public()
  @ApiOperation({ summary: 'Create an account, optionally with a new organization' })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({ description: 'The new user and an access/refresh token pair.' })
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterDto,
  ): Promise<AuthResponse> {
    const meta = currentRequestMeta();
    const registered = await this.auth.register(
      { email: body.email, password: body.password, displayName: body.displayName ?? null },
      meta,
    );

    if (!body.organizationName) return registered;

    // Creating the organization after registration, then re-issuing the token,
    // keeps one code path for organization creation instead of a second,
    // subtly different one that only runs at sign-up.
    const organization = await this.organizations.create(
      { name: body.organizationName },
      registered.user.id,
    );

    return this.auth.selectOrganization(registered.user.id, organization.id, meta);
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for a token pair' })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ description: 'The authenticated user and a token pair.' })
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginDto): Promise<AuthResponse> {
    return this.auth.login(
      {
        email: body.email,
        password: body.password,
        ...(body.organizationId ? { organizationId: body.organizationId } : {}),
      },
      currentRequestMeta(),
    );
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate a refresh token',
    description:
      'Returns a new pair and invalidates the presented token. Replaying a rotated token ' +
      'revokes the entire session family.',
  })
  @ApiBody({ type: RefreshDto })
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshDto): Promise<AuthResponse> {
    return this.auth.refresh(body.refreshToken, currentRequestMeta());
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the session family for a refresh token' })
  @ApiBody({ type: LogoutDto })
  async logout(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshDto): Promise<void> {
    await this.auth.logout(body.refreshToken, currentRequestMeta());
  }

  @Post('organizations/:organizationId/select')
  @AllowAnyAuthenticated()
  @NoTenantRequired()
  @HttpCode(200)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Switch the active organization',
    description: 'Membership is re-verified and a token scoped to the organization is issued.',
  })
  select(
    @CurrentUser() actor: ActorContext,
    @Param('organizationId') organizationId: string,
  ): Promise<AuthResponse> {
    return this.auth.selectOrganization(actor.userId, organizationId, currentRequestMeta());
  }

  @Get('me')
  @AllowAnyAuthenticated()
  @NoTenantRequired()
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Describe the current session' })
  me(@CurrentUser() actor: ActorContext): ActorContext {
    // Returned straight from the token: no database round trip, and it shows
    // the client exactly what the server believes about this session.
    return actor;
  }
}
