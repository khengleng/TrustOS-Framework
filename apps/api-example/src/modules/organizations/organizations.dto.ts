import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { emailSchema, organizationNameSchema, slugSchema, z } from '@trustsystem/validation';
import { SYSTEM_ROLE_NAMES } from '@trustsystem/rbac';

/** Role names an organization endpoint will accept. `super_admin` is excluded. */
const assignableRoleSchema = z
  .string()
  .min(2)
  .max(64)
  .refine((value) => value !== 'super_admin', {
    message: 'super_admin is a platform role and cannot be assigned to a member.',
  });

export const createOrganizationSchema = z.object({
  name: organizationNameSchema,
  slug: slugSchema.optional(),
});

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Ltd' })
  name!: string;

  @ApiPropertyOptional({ example: 'acme-ltd', description: 'Derived from the name when omitted.' })
  slug?: string;
}

export const inviteMemberSchema = z.object({
  email: emailSchema,
  roleName: assignableRoleSchema.optional(),
});

export class InviteMemberDto {
  @ApiProperty({ example: 'newcomer@acme.test' })
  email!: string;

  @ApiPropertyOptional({
    enum: SYSTEM_ROLE_NAMES.filter((name) => name !== 'super_admin'),
    description: 'Defaults to the least-privileged role (operator).',
  })
  roleName?: string;
}

export const assignRoleSchema = z.object({
  roleName: assignableRoleSchema,
});

export class AssignRoleDto {
  @ApiProperty({ enum: SYSTEM_ROLE_NAMES.filter((name) => name !== 'super_admin') })
  roleName!: string;
}
