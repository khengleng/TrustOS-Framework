import { ApiError } from '@trustsystem/errors';
import type { ModuleContext } from '@trustsystem/module-sdk';
import { buildPageMeta, type Paginated } from '@trustsystem/shared-types';
import type { ReportingConfig } from './config';
import {
  exportFilename,
  toCsv,
  type ExportFormat,
  type ExportResult,
  type PdfRenderer,
} from './export';
import { resolveFilters, toSummary, type ReportDefinition, type ReportSummary } from './report';
import {
  nextRunAt,
  reportScheduleSchema,
  type ReportScheduleInput,
  type ReportScheduleRow,
  type ReportScheduleStore,
} from './schedule';

/**
 * Reporting for one application.
 *
 * The service owns filtering, pagination, export and audit. It does not own the
 * data: each report brings its own source, and the source is responsible for
 * scoping to the organization it is given. The service re-checks anyway — a row
 * carrying a foreign `organizationId` is dropped and the report fails rather than
 * returning it, because a report is precisely the shape in which a cross-tenant
 * leak goes unnoticed: a list of rows nobody reads individually.
 */

export interface RunReportQuery {
  filters?: Record<string, unknown>;
  page?: number;
  pageSize?: number;
}

export class ReportingService {
  private readonly definitions = new Map<string, ReportDefinition>();

  constructor(
    private readonly context: ModuleContext<ReportingConfig>,
    private readonly schedules: ReportScheduleStore,
    private readonly pdf: PdfRenderer,
  ) {}

  /**
   * Registers a report definition.
   *
   * Called by the application at start-up. Registering twice is refused rather
   * than overwriting: two definitions sharing an id would mean the report a caller
   * gets depends on module import order.
   */
  register(definition: ReportDefinition): this {
    if (this.definitions.has(definition.id)) {
      throw ApiError.internal(`A report with id "${definition.id}" is already registered.`);
    }
    this.definitions.set(definition.id, definition);
    return this;
  }

  /** Reports the caller may see, filtered by the permission each declares. */
  list(permissions: string[]): ReportSummary[] {
    const held = new Set(permissions);
    const all = held.has('*');

    return [...this.definitions.values()]
      .filter((definition) => all || held.has(definition.permission))
      .map(toSummary)
      .sort((left, right) => (left.id < right.id ? -1 : 1));
  }

  find(id: string, permissions: string[]): ReportSummary {
    return toSummary(this.require(id, permissions));
  }

  /**
   * Runs a report.
   *
   * Reads are audited. A report is a bulk read of customer data, which is exactly
   * what an insider-threat review asks about later; the filters are recorded, the
   * rows are not.
   */
  async run(
    id: string,
    organizationId: string,
    permissions: string[],
    query: RunReportQuery = {},
  ): Promise<Paginated<Record<string, unknown>>> {
    const config = await this.context.resolveConfig(organizationId);
    const definition = this.require(id, permissions);
    const filters = resolveFilters(definition, query.filters ?? {});

    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(config.maxPageSize, Math.max(1, Math.floor(query.pageSize ?? 25)));

    const result = await definition.dataSource({
      organizationId,
      filters,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    this.assertRowsBelongTo(organizationId, result.rows, id);

    await this.context.audit.record({
      action: 'reporting.report.run',
      entityType: 'ReportDefinition',
      entityId: id,
      organizationId,
      after: { filters, page, pageSize, rows: result.rows.length },
    });

    return { items: result.rows, meta: buildPageMeta({ page, pageSize }, result.totalRows) };
  }

  /**
   * Exports a report.
   *
   * The row ceiling is applied to the export rather than to the report: paging
   * through a large report interactively is fine, and materialising all of it into
   * one file is what exhausts memory.
   */
  async export(
    id: string,
    organizationId: string,
    permissions: string[],
    format: ExportFormat,
    query: { filters?: Record<string, unknown> } = {},
  ): Promise<ExportResult> {
    const config = await this.context.resolveConfig(organizationId);
    const definition = this.require(id, permissions);
    const filters = resolveFilters(definition, query.filters ?? {});

    const result = await definition.dataSource({
      organizationId,
      filters,
      skip: 0,
      take: config.maxExportRows,
    });

    this.assertRowsBelongTo(organizationId, result.rows, id);

    if (result.totalRows > config.maxExportRows) {
      // Refused rather than silently truncated: a partial export that looks
      // complete is how a reconciliation ends up short by exactly the rows nobody
      // knew were missing.
      throw ApiError.validation(
        [
          {
            path: 'filters',
            message: `The report has ${result.totalRows} rows; the export limit is ${config.maxExportRows}. Narrow the filters.`,
          },
        ],
        'The report is too large to export.',
      );
    }

    const generatedAt = this.context.clock();
    const content =
      format === 'csv'
        ? Buffer.from(toCsv(definition.columns, result.rows), 'utf8')
        : await this.pdf.render({
            title: definition.name,
            columns: definition.columns,
            rows: result.rows,
          });

    await this.context.audit.record({
      action: 'reporting.report.exported',
      entityType: 'ReportDefinition',
      entityId: id,
      organizationId,
      after: { format, filters, rows: result.rows.length, byteSize: content.byteLength },
    });

    return {
      format,
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      filename: exportFilename(definition.id, format, generatedAt),
      content,
    };
  }

  // --- schedules ------------------------------------------------------------

  listSchedules(): Promise<ReportScheduleRow[]> {
    return this.schedules.list();
  }

  async schedule(
    input: ReportScheduleInput,
    organizationId: string,
    permissions: string[],
  ): Promise<ReportScheduleRow> {
    const parsed = reportScheduleSchema.parse(input);
    // Scheduling a report the caller cannot run would be a way to receive data
    // they are not permitted to read.
    this.require(parsed.reportId, permissions);

    const row = await this.schedules.create({
      reportId: parsed.reportId,
      frequency: parsed.frequency,
      hourUtc: parsed.hourUtc,
      dayOfWeek: parsed.dayOfWeek,
      dayOfMonth: parsed.dayOfMonth,
      format: parsed.format,
      filters: parsed.filters,
      nextRunAt: nextRunAt(parsed, this.context.clock()),
      lastRunAt: null,
    });

    await this.context.audit.record({
      action: 'reporting.schedule.created',
      entityType: 'ReportSchedule',
      entityId: row.id,
      organizationId,
      after: {
        reportId: row.reportId,
        frequency: row.frequency,
        hourUtc: row.hourUtc,
        nextRunAt: row.nextRunAt.toISOString(),
      },
    });

    return row;
  }

  async removeSchedule(id: string, organizationId: string): Promise<ReportScheduleRow> {
    const existing = await this.schedules.find(id, organizationId);
    const removed = await this.schedules.softDelete(id, this.context.clock());

    await this.context.audit.record({
      action: 'reporting.schedule.deleted',
      entityType: 'ReportSchedule',
      entityId: id,
      organizationId,
      before: { reportId: existing.reportId, frequency: existing.frequency },
    });

    return removed;
  }

  /** Schedules whose next run has passed. The application decides what to do. */
  async dueSchedules(organizationId: string): Promise<ReportScheduleRow[]> {
    const now = this.context.clock();
    return (await this.schedules.list()).filter(
      (row) => row.organizationId === organizationId && row.nextRunAt.getTime() <= now.getTime(),
    );
  }

  /** Records that a scheduled run happened and advances `nextRunAt`. */
  async markScheduleRun(id: string, organizationId: string): Promise<ReportScheduleRow> {
    const schedule = await this.schedules.find(id, organizationId);
    const now = this.context.clock();

    return this.schedules.update(id, {
      lastRunAt: now,
      nextRunAt: nextRunAt(schedule, now),
    });
  }

  // --- internals ------------------------------------------------------------

  private require(id: string, permissions: string[]): ReportDefinition {
    const definition = this.definitions.get(id);

    // A report the caller may not read is reported as not_found rather than
    // forbidden: a 403 would confirm which reports exist, and a report id names
    // the data it exposes.
    if (!definition) throw ApiError.notFound(`No report with id "${id}".`);

    const held = new Set(permissions);
    if (!held.has('*') && !held.has(definition.permission)) {
      throw ApiError.notFound(`No report with id "${id}".`);
    }
    return definition;
  }

  private assertRowsBelongTo(
    organizationId: string,
    rows: Array<Record<string, unknown>>,
    reportId: string,
  ): void {
    const foreign = rows.find(
      (row) => typeof row.organizationId === 'string' && row.organizationId !== organizationId,
    );
    if (!foreign) return;

    throw new ApiError('internal_error', {
      message: 'The report could not be produced.',
      context: {
        reason: 'report_row_cross_tenant',
        reportId,
        expectedOrganizationId: organizationId,
      },
    });
  }
}
