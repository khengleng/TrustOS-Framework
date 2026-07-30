import { ApiError } from '@trustos/errors';
import { z } from 'zod';

/**
 * Report definitions.
 *
 * A report is a declaration — columns, filters, and a data source — registered by
 * the application at start-up. Definitions are code rather than rows, on purpose:
 * a report that can be authored at runtime is a query builder, and a query builder
 * exposed to customers is an unbounded read of whatever the database will join.
 * Applications register what they are willing to expose; the module owns
 * filtering, pagination, export and audit.
 */

export const columnTypeSchema = z.enum(['string', 'number', 'date', 'boolean']);
export type ColumnType = z.infer<typeof columnTypeSchema>;

export const reportColumnSchema = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    type: columnTypeSchema.default('string'),
  })
  .strict();

export type ReportColumn = z.infer<typeof reportColumnSchema>;

export const reportFilterSchema = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    type: columnTypeSchema.default('string'),
    required: z.boolean().default(false),
  })
  .strict();

export type ReportFilter = z.infer<typeof reportFilterSchema>;

export interface ReportQuery {
  organizationId: string;
  /** Values for the declared filters, already coerced to their declared types. */
  filters: Record<string, string | number | boolean | Date>;
  skip: number;
  take: number;
}

export interface ReportPage {
  rows: Array<Record<string, unknown>>;
  totalRows: number;
}

/**
 * Where a report's rows come from.
 *
 * The data source receives `organizationId` and is responsible for scoping to it.
 * `createPrismaReportDataSource` does that through the framework's tenant-scoped
 * delegate; a hand-written source must do the same, and the service re-checks
 * every row that carries an `organizationId` field before returning it.
 */
export type ReportDataSource = (query: ReportQuery) => Promise<ReportPage>;

export interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  /** Permission a caller needs *in addition to* `reporting.report.run`. */
  permission: string;
  columns: ReportColumn[];
  filters: ReportFilter[];
  dataSource: ReportDataSource;
}

/** A definition without its data source, for listing over HTTP. */
export type ReportSummary = Omit<ReportDefinition, 'dataSource'>;

export function toSummary(definition: ReportDefinition): ReportSummary {
  const { dataSource: _dataSource, ...summary } = definition;
  return summary;
}

/**
 * Coerces and validates supplied filter values against the declaration.
 *
 * An undeclared filter is rejected rather than ignored: silently dropping it
 * would return a full result set to a caller who believed they had narrowed it,
 * and that difference matters when the report is a list of customers.
 */
export function resolveFilters(
  definition: ReportDefinition,
  supplied: Record<string, unknown>,
): Record<string, string | number | boolean | Date> {
  const declared = new Map(definition.filters.map((filter) => [filter.key, filter]));
  const problems: Array<{ path: string; message: string }> = [];
  const resolved: Record<string, string | number | boolean | Date> = {};

  for (const [key, value] of Object.entries(supplied)) {
    const filter = declared.get(key);
    if (!filter) {
      problems.push({ path: `filters.${key}`, message: 'Not a filter on this report.' });
      continue;
    }
    if (value === undefined || value === null || value === '') continue;

    const coerced = coerce(filter.type, value);
    if (coerced === undefined) {
      problems.push({ path: `filters.${key}`, message: `Expected a ${filter.type}.` });
      continue;
    }
    resolved[key] = coerced;
  }

  for (const filter of definition.filters) {
    if (filter.required && resolved[filter.key] === undefined) {
      problems.push({ path: `filters.${filter.key}`, message: 'Required.' });
    }
  }

  if (problems.length > 0) {
    throw ApiError.validation(problems, 'The report filters are not valid.');
  }
  return resolved;
}

function coerce(type: ColumnType, value: unknown): string | number | boolean | Date | undefined {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : String(value);
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    case 'date': {
      const parsed = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }
    default:
      return undefined;
  }
}

/**
 * A data source over one Prisma model, tenant-scoped.
 *
 * Filters are passed to Prisma as structured arguments, never interpolated into a
 * string, so a filter value cannot become part of the query.
 */
export function createPrismaReportDataSource(options: {
  /** Tenant-scoped delegate factory, e.g. () => scopedDelegate(prisma.payment). */
  delegate: () => {
    findMany(args?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
    count(args?: Record<string, unknown>): Promise<number>;
  };
  /** Maps a filter key to a Prisma `where` fragment. */
  where?: (filters: ReportQuery['filters']) => Record<string, unknown>;
  orderBy?: Record<string, unknown>;
}): ReportDataSource {
  return async (query: ReportQuery): Promise<ReportPage> => {
    const delegate = options.delegate();
    const where = options.where ? options.where(query.filters) : {};

    const [rows, totalRows] = await Promise.all([
      delegate.findMany({
        where,
        ...(options.orderBy ? { orderBy: options.orderBy } : {}),
        skip: query.skip,
        take: query.take,
      }),
      delegate.count({ where }),
    ]);

    return { rows, totalRows };
  };
}

/** A fixed-row data source. Used by tests and by static reference reports. */
export function createStaticReportDataSource(
  rows: Array<Record<string, unknown>>,
): ReportDataSource {
  return async (query: ReportQuery): Promise<ReportPage> => ({
    rows: rows.slice(query.skip, query.skip + query.take),
    totalRows: rows.length,
  });
}
