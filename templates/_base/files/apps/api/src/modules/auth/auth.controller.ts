import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuthService, CurrentUser, Public } from '@trustos/auth';
import { AllowAnyAuthenticated } from '@trustos/rbac';
import { NoTenantRequired } from '@trustos/tenancy';
import type { ActorContext, AuthResponse } from '@trustos/shared-types';
import { emailSchema, idSchema, passwordSchema, z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { AUTH_SERVICE } from '../../tokens';
import { currentRequestMeta } from '../../common/request-meta';

/**
 * Authentication endpoints.
 *
 * `/refresh` and `/logout` are public by necessity — they are called precisely
 * when the access token has expired — and are protected by the refresh token
 * itself, which rotates on every use.
 */

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(120).optional(),
});

// Login must not apply the password *policy*: tightening it later would lock
// out existing accounts. It only checks that something was sent.
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  organizationId: idSchema.optional(),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1).max(4096) });

class RegisterDto {
  @ApiProperty({ example: 'ada@example.com' })
  email!: string;

  @ApiProperty({ example: 'CorrectHorse7Battery', minLength: 12 })
  password!: string;

  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  displayName?: string;
}

class LoginDto {
  @ApiProperty({ example: 'ada@example.com' })
  email!: string;

  @ApiProperty()
  password!: string;

  @ApiPropertyOptional()
  organizationId?: string;
}

class RefreshDto {
  @ApiProperty()
  refreshToken!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AUTH_SERVICE) private readonly auth: AuthService) {}

  @Post('register')
  @Public()
  @ApiOperation({ summary: 'Create an account' })
  @ApiBody({ type: RegisterDto })
  register(@Body(new ZodValidationPipe(registerSchema)) body: RegisterDto): Promise<AuthResponse> {
    return this.auth.register(
      { email: body.email, password: body.password, displayName: body.displayName ?? null },
      currentRequestMeta(),
    );
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for a token pair' })
  @ApiBody({ type: LoginDto })
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
  @ApiBody({ type: RefreshDto })
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
    // Straight from the token: no database round trip, and it shows the client
    // exactly what the server believes about this session.
    return actor;
  }
}
