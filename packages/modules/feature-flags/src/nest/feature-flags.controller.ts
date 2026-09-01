import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@trustsystem/rbac';
import { OrganizationId } from '@trustsystem/tenancy';
import { z } from '@trustsystem/validation';
import { ZodValidationPipe } from '@trustsystem/validation/nest';
import type { Evaluation } from '../evaluate';
import type { FeatureFlagsService } from '../feature-flags.service';
import type { FeatureFlagRow } from '../store';
import { FEATURE_FLAGS_SERVICE } from './tokens';

/**
 * Feature flag endpoints.
 *
 * `evaluate` is a POST rather than a GET even though it reads: it takes a subject
 * id in the body, and a subject id in a query string ends up in access logs,
 * browser history and referrer headers.
 */

const flagKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, 'Lowercase, dot or hyphen separated.');

const createSchema = z.object({
  key: flagKeySchema,
  description: z.string().trim().min(1).max(400),
  enabled: z.boolean().default(false),
  rolloutPercentage: z.number().int().min(0).max(100).default(0),
  environments: z
    .array(z.enum(['development', 'test', 'production']))
    .max(3)
    .default([]),
  expiresAt: z.coerce.date().nullable().default(null),
});

const updateSchema = z
  .object({
    description: z.string().trim().min(1).max(400).optional(),
    enabled: z.boolean().optional(),
    rolloutPercentage: z.number().int().min(0).max(100).optional(),
    environments: z
      .array(z.enum(['development', 'test', 'production']))
      .max(3)
      .optional(),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

const evaluateSchema = z.object({
  subjectId: z.string().trim().min(1).max(120).nullable().default(null),
});

@ApiTags('feature-flags')
@ApiBearerAuth('access-token')
@Controller('feature-flags')
export class FeatureFlagsController {
  constructor(@Inject(FEATURE_FLAGS_SERVICE) private readonly flags: FeatureFlagsService) {}

  @Get()
  @RequirePermissions('feature-flags.flag.read')
  @ApiOperation({ summary: 'List flags.' })
  list(): Promise<FeatureFlagRow[]> {
    return this.flags.list();
  }

  @Post()
  @RequirePermissions('feature-flags.flag.manage')
  @ApiOperation({ summary: 'Create a flag.' })
  create(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createSchema)) body: z.infer<typeof createSchema>,
  ): Promise<FeatureFlagRow> {
    return this.flags.create(body, organizationId);
  }

  @Get(':key')
  @RequirePermissions('feature-flags.flag.read')
  @ApiOperation({ summary: 'Read one flag.' })
  find(@Param('key') key: string): Promise<FeatureFlagRow> {
    return this.flags.find(key);
  }

  @Put(':key')
  @RequirePermissions('feature-flags.flag.manage')
  @ApiOperation({ summary: 'Update a flag.' })
  update(
    @Param('key') key: string,
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ): Promise<FeatureFlagRow> {
    return this.flags.update(key, body, organizationId);
  }

  @Delete(':key')
  @RequirePermissions('feature-flags.flag.manage')
  @ApiOperation({ summary: 'Remove a flag.' })
  remove(
    @Param('key') key: string,
    @OrganizationId() organizationId: string,
  ): Promise<FeatureFlagRow> {
    return this.flags.remove(key, organizationId);
  }

  @Post(':key/evaluate')
  @RequirePermissions('feature-flags.flag.evaluate')
  @ApiOperation({ summary: 'Evaluate a flag for a subject.' })
  evaluate(
    @Param('key') key: string,
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(evaluateSchema)) body: z.infer<typeof evaluateSchema>,
  ): Promise<Evaluation> {
    return this.flags.evaluate(key, organizationId, { subjectId: body.subjectId });
  }
}
