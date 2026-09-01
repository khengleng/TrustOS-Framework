import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@trustsystem/auth';
import { RequirePermissions } from '@trustsystem/rbac';
import { OrganizationId } from '@trustsystem/tenancy';
import type { ActorContext, Paginated } from '@trustsystem/shared-types';
import { z } from '@trustsystem/validation';
import { ZodValidationPipe } from '@trustsystem/validation/nest';
import { EXPORT_FORMATS } from '../export';
import type { ReportSummary } from '../report';
import { FREQUENCIES, type ReportScheduleRow } from '../schedule';
import type { ReportingService } from '../reporting.service';
import { REPORTING_SERVICE } from './tokens';

/**
 * Reporting endpoints.
 *
 * The actor's permission set is a business input here as well as an
 * authorization check: `reporting.report.read` says "may use reports at all",
 * while each report declares the permission that governs the data it exposes.
 */

const filtersSchema = z
  .record(z.string().max(80), z.union([z.string().max(400), z.number(), z.boolean()]))
  .default({});

const runSchema = z.object({
  filters: filtersSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
});

const exportSchema = z.object({
  format: z.enum(EXPORT_FORMATS).default('csv'),
  filters: filtersSchema,
});

const scheduleSchema = z.object({
  reportId: z.string().trim().min(1).max(80),
  frequency: z.enum(FREQUENCIES),
  hourUtc: z.number().int().min(0).max(23).default(6),
  dayOfWeek: z.number().int().min(1).max(7).nullable().default(null),
  dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
  format: z.enum(EXPORT_FORMATS).default('csv'),
  filters: filtersSchema,
});

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports')
export class ReportingController {
  constructor(@Inject(REPORTING_SERVICE) private readonly reports: ReportingService) {}

  @Get()
  @RequirePermissions('reporting.report.read')
  @ApiOperation({ summary: 'List report definitions the caller may run.' })
  list(@CurrentUser() actor: ActorContext): ReportSummary[] {
    return this.reports.list(actor.permissions);
  }

  @Get('schedules')
  @RequirePermissions('reporting.schedule.read')
  @ApiOperation({ summary: 'List scheduled reports.' })
  listSchedules(): Promise<ReportScheduleRow[]> {
    return this.reports.listSchedules();
  }

  @Post('schedules')
  @RequirePermissions('reporting.schedule.manage')
  @ApiOperation({ summary: 'Schedule a report.' })
  schedule(
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(scheduleSchema)) body: z.infer<typeof scheduleSchema>,
  ): Promise<ReportScheduleRow> {
    return this.reports.schedule(body, organizationId, actor.permissions);
  }

  @Delete('schedules/:id')
  @RequirePermissions('reporting.schedule.manage')
  @ApiOperation({ summary: 'Remove a scheduled report.' })
  removeSchedule(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
  ): Promise<ReportScheduleRow> {
    return this.reports.removeSchedule(id, organizationId);
  }

  @Get(':id')
  @RequirePermissions('reporting.report.read')
  @ApiOperation({ summary: 'Read one report definition.' })
  find(@Param('id') id: string, @CurrentUser() actor: ActorContext): ReportSummary {
    return this.reports.find(id, actor.permissions);
  }

  @Post(':id/run')
  @RequirePermissions('reporting.report.run')
  @ApiOperation({ summary: 'Run a report.' })
  run(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(runSchema)) body: z.infer<typeof runSchema>,
  ): Promise<Paginated<Record<string, unknown>>> {
    return this.reports.run(id, organizationId, actor.permissions, body);
  }

  @Post(':id/export')
  @RequirePermissions('reporting.report.export')
  @ApiOperation({ summary: 'Export a report. Content is base64 encoded.' })
  async export(
    @Param('id') id: string,
    @OrganizationId() organizationId: string,
    @CurrentUser() actor: ActorContext,
    @Body(new ZodValidationPipe(exportSchema)) body: z.infer<typeof exportSchema>,
  ): Promise<{ filename: string; contentType: string; content: string }> {
    const result = await this.reports.export(id, organizationId, actor.permissions, body.format, {
      filters: body.filters,
    });

    return {
      filename: result.filename,
      contentType: result.contentType,
      content: result.content.toString('base64'),
    };
  }
}
