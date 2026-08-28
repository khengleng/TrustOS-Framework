import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '@trustos/rbac';
import { OrganizationId } from '@trustos/tenancy';
import { z } from '@trustos/validation';
import { ZodValidationPipe } from '@trustos/validation/nest';
import { WIDGET_PERMISSIONS } from './widgets.permissions';
import { WidgetsService } from './widgets.service';
import type { Widget } from './widgets.repository';

const createWidgetSchema = z.object({ name: z.string().trim().min(1).max(120) });

/**
 * Example product endpoints.
 *
 * Every route declares a permission. `PermissionsGuard` denies any route that
 * declares none, so there is no such thing as an accidentally public endpoint
 * in a service built on this template.
 */
@ApiTags('widgets')
@ApiBearerAuth('access-token')
@Controller('widgets')
export class WidgetsController {
  constructor(private readonly widgets: WidgetsService) {}

  @Get()
  @RequirePermissions(WIDGET_PERMISSIONS.READ)
  @ApiOperation({ summary: 'List widgets in the current organization' })
  list(@OrganizationId() organizationId: string): Promise<Widget[]> {
    return this.widgets.list(organizationId);
  }

  @Post()
  @RequirePermissions(WIDGET_PERMISSIONS.CREATE)
  @ApiOperation({ summary: 'Create a widget' })
  create(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createWidgetSchema)) body: { name: string },
  ): Promise<Widget> {
    return this.widgets.create(organizationId, body.name);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(WIDGET_PERMISSIONS.DELETE)
  @ApiOperation({ summary: 'Soft-delete a widget' })
  remove(@OrganizationId() organizationId: string, @Param('id') id: string): Promise<void> {
    return this.widgets.remove(organizationId, id);
  }
}
