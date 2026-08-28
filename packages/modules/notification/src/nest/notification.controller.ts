import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@trustos/rbac';
import { OrganizationId } from '@trustos/tenancy';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import type { Paginated } from '@trustos/shared-types';
import { CHANNEL_IDS } from '../channels';
import { DELIVERY_STATUSES } from '../delivery';
import type { NotificationConfig } from '../config';
import type { NotificationService } from '../notification.service';
import type {
  NotificationAttemptRow,
  NotificationMessageRow,
  NotificationTemplateRow,
} from '../store';
import { NOTIFICATION_SERVICE } from './tokens';

/**
 * Notification endpoints.
 *
 * Every route declares a permission from the module's catalog entry; the
 * organization comes from `@OrganizationId()`, never from the body.
 *
 * Note which permission guards settings: `notification.settings.manage` is
 * suggested for `organization_owner` alone, because changing the sender identity
 * changes what recipients see the message as coming from.
 */

const templateKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'Lowercase, dot, underscore or hyphen separated.');

const variableNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'A variable name must be a plain identifier.');

const createTemplateSchema = z.object({
  key: templateKeySchema,
  name: z.string().trim().min(1).max(120),
  channel: z.enum(CHANNEL_IDS),
  subject: z.string().max(200),
  body: z.string().min(1).max(20_000),
  variables: z.array(variableNameSchema).max(50).default([]),
});

const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(20_000).optional(),
    variables: z.array(variableNameSchema).max(50).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

const sendSchema = z.object({
  templateKey: templateKeySchema,
  channel: z.enum(CHANNEL_IDS),
  target: z.string().trim().min(1).max(400),
  // Values only, and only strings: the engine substitutes literally, so there is
  // nothing useful to pass that is not already text.
  variables: z.record(variableNameSchema, z.string().max(4000)).default({}),
});

const listSchema = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const settingsSchema = z
  .object({
    defaultSender: z.string().trim().min(1).max(160).optional(),
    enabledChannels: z.array(z.enum(CHANNEL_IDS)).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationController {
  constructor(@Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService) {}

  @Get('messages')
  @RequirePermissions('notification.message.read')
  @ApiOperation({ summary: 'List messages and delivery status.' })
  listMessages(
    @OrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>,
  ): Promise<Paginated<NotificationMessageRow>> {
    return this.notifications.listMessages(organizationId, query);
  }

  @Get('messages/:id')
  @RequirePermissions('notification.message.read')
  @ApiOperation({ summary: 'Read one message with its delivery attempts.' })
  findMessage(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<{ message: NotificationMessageRow; attempts: NotificationAttemptRow[] }> {
    return this.notifications.findMessage(id, organizationId);
  }

  @Post('messages')
  @RequirePermissions('notification.message.send')
  @ApiOperation({ summary: 'Render a template and queue it for delivery.' })
  send(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(sendSchema)) body: z.infer<typeof sendSchema>,
  ): Promise<NotificationMessageRow> {
    return this.notifications.send(body, organizationId);
  }

  @Post('messages/:id/retry')
  @RequirePermissions('notification.message.send')
  @ApiOperation({ summary: 'Retry a failed message.' })
  retry(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<NotificationMessageRow> {
    return this.notifications.retry(id, organizationId);
  }

  @Get('templates')
  @RequirePermissions('notification.template.read')
  @ApiOperation({ summary: 'List message templates.' })
  listTemplates(): Promise<NotificationTemplateRow[]> {
    return this.notifications.listTemplates();
  }

  @Post('templates')
  @RequirePermissions('notification.template.manage')
  @ApiOperation({ summary: 'Create a message template.' })
  createTemplate(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createTemplateSchema)) body: z.infer<typeof createTemplateSchema>,
  ): Promise<NotificationTemplateRow> {
    return this.notifications.createTemplate(body, organizationId);
  }

  @Put('templates/:id')
  @RequirePermissions('notification.template.manage')
  @ApiOperation({ summary: 'Update a message template.' })
  updateTemplate(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: z.infer<typeof updateTemplateSchema>,
  ): Promise<NotificationTemplateRow> {
    return this.notifications.updateTemplate(id, body, organizationId);
  }

  @Delete('templates/:id')
  @RequirePermissions('notification.template.manage')
  @ApiOperation({ summary: 'Retire a message template.' })
  deleteTemplate(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<NotificationTemplateRow> {
    return this.notifications.deleteTemplate(id, organizationId);
  }

  @Get('settings')
  @RequirePermissions('notification.settings.read')
  @ApiOperation({ summary: 'Read this organization channel settings.' })
  readSettings(@OrganizationId() organizationId: string): Promise<NotificationConfig> {
    return this.notifications.readSettings(organizationId);
  }

  @Put('settings')
  @RequirePermissions('notification.settings.manage')
  @ApiOperation({ summary: 'Update this organization channel settings.' })
  updateSettings(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(settingsSchema)) body: z.infer<typeof settingsSchema>,
  ): Promise<NotificationConfig> {
    return this.notifications.updateSettings(body, organizationId);
  }
}
