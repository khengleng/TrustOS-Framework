import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  displayNameSchema,
  emailSchema,
  idSchema,
  organizationNameSchema,
  passwordSchema,
  z,
} from '@trustsystem/validation';

/**
 * Request contracts.
 *
 * Zod schemas are the enforcement; the classes exist so `@nestjs/swagger` can
 * describe the endpoint. They sit in one file precisely so a field added to
 * one and not the other is obvious in review.
 */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
  organizationName: organizationNameSchema.optional(),
});

export class RegisterDto {
  @ApiProperty({ example: 'ada@acme.test' })
  email!: string;

  @ApiProperty({ example: 'CorrectHorse7Battery', minLength: 12 })
  password!: string;

  @ApiPropertyOptional({ example: 'Ada Lovelace' })
  displayName?: string;

  @ApiPropertyOptional({
    example: 'Acme Ltd',
    description: 'When present, an organization is created and the new user becomes its owner.',
  })
  organizationName?: string;
}

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  organizationId: idSchema.optional(),
});

export class LoginDto {
  @ApiProperty({ example: 'ada@acme.test' })
  email!: string;

  @ApiProperty({ example: 'CorrectHorse7Battery' })
  password!: string;

  @ApiPropertyOptional({ description: 'Sign straight into a specific organization.' })
  organizationId?: string;
}

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(4096),
});

export class RefreshDto {
  @ApiProperty()
  refreshToken!: string;
}

export class LogoutDto {
  @ApiProperty()
  refreshToken!: string;
}
