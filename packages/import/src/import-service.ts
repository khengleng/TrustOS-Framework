import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';
import type { AuditService } from '@trustsystem/audit';
import type { LoggerPort } from '@trustsystem/logging';
import { z } from 'zod';
import {
  DEFAULT_PARSE_LIMITS,
  type ParseLimits,
  type ParsedRow,
  type ParserRegistry,
} from './parsers';

/**
 * Running an import.
 *
 * The shape of every import, and the reason for each stage:
 *
 *     parse → validate → preview → apply → (rollback)
 *
 *   * **Validation happens before anything is written.** All of it. An import that wrote 4,000
 *     rows and then failed on row 4,001 leaves a state nobody asked for and nobody can describe.
 *   * **A preview is a dry run that reports what *would* happen**, including which rows would be
 *     rejected and why. This is the single feature that makes bulk import usable: the alternative
 *     is importing, discovering forty bad rows, and unpicking them by hand.
 *   * **Apply is all-or-nothing by default.** The handler runs inside a transaction the caller
 *     supplies. A partial import is recoverable only if somebody can tell which half succeeded,
 *     and after the fact nobody can.
 *   * **Rollback exists for the case where all-or-nothing was not possible** — an import that
 *     called an external system, for instance. It undoes what was recorded, in reverse order.
 */

export const IMPORT_STATUSES = [
  'pending',
  'validating',
  'previewed',
  'applying',
  'completed',
  'failed',
  'rolled_back',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface ImportRun {
  id: string;
  organizationId: string | null;
  /** Which handler processes it. Registered at start-up. */
  type: string;
  format: string;
  fileName: string;
  fileSizeBytes: number;
  /** SHA-256 of the uploaded bytes. Detects a re-upload of the same file. */
  checksum: string;
  status: ImportStatus;
  dryRun: boolean;

  rowsRead: number;
  rowsAccepted: number;
  rowsRejected: number;

  /** Bounded — see `MAX_STORED_ERRORS`. */
  errors: ImportRowError[];
  /** Handler-supplied summary of what was applied. Enough to drive a rollback. */
  appliedSummary: unknown;

  startedAt: Date;
  completedAt: Date | null;
  createdById: string | null;
}

export interface ImportRowError {
  rowNumber: number;
  /** The offending column, or null for a row-level problem. */
  column: string | null;
  message: string;
  /** The value that failed, truncated. Omitted for a column the handler marked sensitive. */
  value: string | null;
}

/**
 * How many row errors are stored.
 *
 * A 100,000-row file with a wrong header produces 100,000 identical errors, and storing them all
 * makes the record unreadable and the row enormous. The count is always exact; the detail is
 * capped, and the report says so.
 */
export const MAX_STORED_ERRORS = 500;

export interface ImportContext<TRow> {
  importId: string;
  organizationId: string | null;
  rows: Array<{ rowNumber: number; data: TRow }>;
  actorId: string | null;
  dryRun: boolean;
  reportProgress?: (percent: number) => Promise<void>;
}

export interface ImportHandlerDefinition<TRow = unknown> {
  type: string;
  description: string;
  /** Validates one row. Runs on every row before anything is applied. */
  row: z.ZodType<TRow>;
  /**
   * Applies the validated rows.
   *
   * Should be transactional. The returned summary is handed back to `rollback`, so it must
   * contain whatever undoing the work requires — usually the ids that were created.
   */
  apply: (context: ImportContext<TRow>) => Promise<{ applied: number; summary?: unknown }>;
  /**
   * Undoes an applied import.
   *
   * Optional. Without it an import cannot be rolled back, and `rollback` says so rather than
   * pretending to succeed.
   */
  rollback?: (context: {
    importId: string;
    organizationId: string | null;
    summary: unknown;
    actorId: string | null;
  }) => Promise<{ reverted: number }>;

  /** Columns whose values are never echoed into an error report. */
  sensitiveColumns?: string[];
  limits?: ParseLimits;
}

export interface ImportStore {
  create(run: ImportRun): Promise<ImportRun>;
  findById(id: string, organizationId: string | null): Promise<ImportRun | null>;
  update(id: string, patch: Partial<ImportRun>): Promise<void>;
  list(filter: {
    organizationId: string | null;
    type?: string;
    status?: ImportStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ImportRun[]; total: number }>;
}

export interface ImportServiceOptions {
  store: ImportStore;
  parsers: ParserRegistry;
  handlers?: ImportHandlerDefinition[];
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class ImportService {
  private readonly handlers = new Map<string, ImportHandlerDefinition>();
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: ImportServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    for (const handler of options.handlers ?? []) this.register(handler);
  }

  register<TRow>(handler: ImportHandlerDefinition<TRow>): this {
    if (this.handlers.has(handler.type)) {
      throw ApiError.conflict(`An import handler for "${handler.type}" is already registered.`, {
        reason: 'import_handler_conflict',
        type: handler.type,
      });
    }
    this.handlers.set(handler.type, handler as ImportHandlerDefinition);
    return this;
  }

  private handler(type: string): ImportHandlerDefinition {
    const handler = this.handlers.get(type);

    if (!handler) {
      const known = [...this.handlers.keys()].sort().join(', ') || '(none)';
      throw ApiError.validation(
        [{ path: 'type', message: `No import handler for "${type}". Registered: ${known}.` }],
        `Unknown import type "${type}".`,
      );
    }

    return handler;
  }

  /**
   * Parses and validates without writing anything.
   *
   * The stage that makes bulk import usable. The alternative is importing, discovering forty bad
   * rows afterwards, and unpicking them by hand.
   */
  async preview(input: {
    type: string;
    format: string;
    fileName: string;
    content: Buffer;
    organizationId: string | null;
    actorId: string | null;
    /** How many valid rows to show back. Not how many are validated — that is all of them. */
    sampleSize?: number;
  }): Promise<{
    run: ImportRun;
    sample: Array<{ rowNumber: number; data: unknown }>;
    columns: string[];
    unknownColumns: string[];
  }> {
    const handler = this.handler(input.type);
    const { run, valid, parsed } = await this.parseAndValidate(input, handler, true);

    /*
     * Columns the handler does not use.
     *
     * A warning rather than an error. A file exported from another system routinely has extra
     * columns, and refusing it would make every import a data-cleaning exercise first. But a
     * *typo* in a column name also shows up here, and that is worth seeing — `emial` in this list
     * is the whole explanation for why every row is missing its email.
     */
    const known = knownKeys(handler.row);
    const unknownColumns =
      known === null ? [] : parsed.columns.filter((column) => !known.has(column));

    return {
      run,
      sample: valid.slice(0, input.sampleSize ?? 20),
      columns: parsed.columns,
      unknownColumns,
    };
  }

  /**
   * Parses, validates and applies.
   *
   * Refuses to apply anything if any row is invalid, unless `partial` is set. That default is the
   * important one: an import that wrote 4,000 rows and stopped leaves a state nobody can
   * describe afterwards.
   */
  async apply(input: {
    type: string;
    format: string;
    fileName: string;
    content: Buffer;
    organizationId: string | null;
    actorId: string | null;
    /**
     * Applies the valid rows and reports the rest.
     *
     * For a file that is expected to be imperfect. Off by default, because "some of it worked" is
     * only recoverable if somebody can tell which part — and after the fact nobody can.
     */
    partial?: boolean;
    reportProgress?: (percent: number) => Promise<void>;
  }): Promise<ImportRun> {
    const handler = this.handler(input.type);
    const { run, valid } = await this.parseAndValidate(input, handler, false);

    if (run.rowsRejected > 0 && !input.partial) {
      await this.options.store.update(run.id, {
        status: 'failed',
        completedAt: this.now(),
      });

      throw ApiError.validation(
        run.errors.slice(0, 20).map((error) => ({
          path: `row ${error.rowNumber}${error.column ? `.${error.column}` : ''}`,
          message: error.message,
        })),
        `${run.rowsRejected} of ${run.rowsRead} rows are not valid, so nothing was imported. ` +
          'Fix the file, or pass partial:true to import the valid rows and report the rest.',
      );
    }

    await this.options.store.update(run.id, { status: 'applying' });

    try {
      const result = await handler.apply({
        importId: run.id,
        organizationId: input.organizationId,
        rows: valid,
        actorId: input.actorId,
        dryRun: false,
        reportProgress: input.reportProgress,
      });

      const completed: Partial<ImportRun> = {
        status: 'completed',
        rowsAccepted: result.applied,
        appliedSummary: result.summary ?? null,
        completedAt: this.now(),
      };

      await this.options.store.update(run.id, completed);

      await this.options.audit?.record({
        action: 'import.completed',
        entityType: 'ImportRun',
        entityId: run.id,
        actorId: input.actorId,
        organizationId: input.organizationId,
        after: {
          type: input.type,
          fileName: input.fileName,
          rowsRead: run.rowsRead,
          rowsAccepted: result.applied,
          rowsRejected: run.rowsRejected,
        },
      });

      return { ...run, ...completed } as ImportRun;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.options.store.update(run.id, {
        status: 'failed',
        completedAt: this.now(),
        errors: [
          ...run.errors,
          { rowNumber: 0, column: null, message: `The import failed: ${message}`, value: null },
        ],
      });

      this.options.logger?.error(
        { importId: run.id, type: input.type, error: message },
        'import failed while applying',
      );

      throw error;
    }
  }

  /**
   * Undoes an applied import.
   *
   * Only for handlers that implement `rollback`. One that does not says so plainly rather than
   * reporting a success that did nothing — which is the worst possible outcome for an operator
   * trying to undo a mistake.
   */
  async rollback(
    importId: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<{ reverted: number }> {
    const run = await this.get(importId, organizationId);

    if (run.status !== 'completed') {
      throw ApiError.conflict(
        `Only a completed import can be rolled back; this one is ${run.status}.`,
        { reason: 'import_not_rollbackable', importId, status: run.status },
      );
    }

    const handler = this.handler(run.type);

    if (!handler.rollback) {
      throw ApiError.validation(
        [
          {
            path: 'type',
            message:
              `The "${run.type}" importer does not support rollback. Undo it manually, or add a ` +
              'rollback implementation to the handler.',
          },
        ],
        'This import cannot be rolled back.',
      );
    }

    const result = await handler.rollback({
      importId: run.id,
      organizationId,
      summary: run.appliedSummary,
      actorId,
    });

    await this.options.store.update(run.id, {
      status: 'rolled_back',
      completedAt: this.now(),
    });

    await this.options.audit?.record({
      action: 'import.rolled_back',
      entityType: 'ImportRun',
      entityId: run.id,
      actorId,
      organizationId,
      before: { status: 'completed', rowsAccepted: run.rowsAccepted },
      after: { status: 'rolled_back', reverted: result.reverted },
    });

    return result;
  }

  /** Parses, validates every row, and records a run. Writes nothing else. */
  private async parseAndValidate(
    input: {
      type: string;
      format: string;
      fileName: string;
      content: Buffer;
      organizationId: string | null;
      actorId: string | null;
    },
    handler: ImportHandlerDefinition,
    dryRun: boolean,
  ) {
    const parser = this.options.parsers.get(input.format);
    const limits = { ...DEFAULT_PARSE_LIMITS, ...handler.limits };
    const parsed = await parser.parse(input.content, limits);

    const { createHash } = await import('node:crypto');
    const checksum = createHash('sha256').update(input.content).digest('hex');

    const errors: ImportRowError[] = parsed.malformed.map((entry) => ({
      rowNumber: entry.rowNumber,
      column: null,
      message: entry.reason,
      value: null,
    }));

    const valid: Array<{ rowNumber: number; data: unknown }> = [];
    let rejected = parsed.malformed.length;

    // Every row is validated, even past the error cap: the *count* must be exact even when the
    // detail is not, or an operator reading "500 errors" cannot tell 500 from 50,000.
    for (const row of parsed.rows) {
      const result = handler.row.safeParse(row.values);

      if (result.success) {
        valid.push({ rowNumber: row.rowNumber, data: result.data });
        continue;
      }

      rejected += 1;

      if (errors.length < MAX_STORED_ERRORS) {
        for (const issue of result.error.issues) {
          const column = issue.path[0] === undefined ? null : String(issue.path[0]);
          errors.push({
            rowNumber: row.rowNumber,
            column,
            message: issue.message,
            value: this.echoableValue(row, column, handler),
          });
        }
      }
    }

    if (parsed.truncated) {
      errors.unshift({
        rowNumber: 0,
        column: null,
        message:
          `Only the first ${limits.maxRows} rows were read. Split the file, or raise the limit ` +
          'for this import type.',
        value: null,
      });
    }

    const run: ImportRun = {
      id: this.newId('imp'),
      organizationId: input.organizationId,
      type: input.type,
      format: input.format,
      fileName: input.fileName,
      fileSizeBytes: input.content.byteLength,
      checksum,
      status: dryRun ? 'previewed' : 'validating',
      dryRun,
      rowsRead: parsed.rows.length + parsed.malformed.length,
      rowsAccepted: dryRun ? valid.length : 0,
      rowsRejected: rejected,
      errors: errors.slice(0, MAX_STORED_ERRORS),
      appliedSummary: null,
      startedAt: this.now(),
      completedAt: dryRun ? this.now() : null,
      createdById: input.actorId,
    };

    await this.options.store.create(run);
    return { run, valid, parsed };
  }

  /**
   * The value to show in an error, or null.
   *
   * A sensitive column's value is never echoed. An error report is read by more people and kept
   * in more places than the import file is, and "row 42: invalid national_id — 010203040" in a
   * support ticket is a leak the framework should not make easy.
   */
  private echoableValue(
    row: ParsedRow,
    column: string | null,
    handler: ImportHandlerDefinition,
  ): string | null {
    if (!column) return null;
    if (handler.sensitiveColumns?.includes(column)) return '[REDACTED]';

    const value = row.values[column];
    if (value === undefined) return null;
    return value.length > 100 ? `${value.slice(0, 100)}…` : value;
  }

  async get(id: string, organizationId: string | null): Promise<ImportRun> {
    const run = await this.options.store.findById(id, organizationId);
    if (!run) throw ApiError.notFound(`No import with id "${id}".`);
    return run;
  }

  async list(filter: Parameters<ImportStore['list']>[0]) {
    return this.options.store.list(filter);
  }

  /**
   * A CSV error report, for download.
   *
   * CSV because the person fixing it is working in a spreadsheet, and a JSON error report means
   * they cannot sort by row number. Values are escaped against formula injection — an error
   * report is the one file guaranteed to be opened in Excel.
   */
  buildErrorReport(run: ImportRun): string {
    const lines = ['row,column,error,value'];

    for (const error of run.errors) {
      lines.push(
        [
          error.rowNumber,
          escapeReportCell(error.column ?? ''),
          escapeReportCell(error.message),
          escapeReportCell(error.value ?? ''),
        ].join(','),
      );
    }

    if (run.rowsRejected > run.errors.length) {
      lines.push(
        `0,,"${run.rowsRejected - run.errors.length} further errors are not listed. Fix these first.",`,
      );
    }

    return lines.join('\n');
  }

  types(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

/**
 * Escapes a cell for the error report.
 *
 * Prefixed with `'` when it would otherwise be read as a formula. An error report is the one file
 * in this system guaranteed to be opened in a spreadsheet, and a message echoing a cell that
 * started with `=` would execute there.
 */
function escapeReportCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  const needsPrefix = /^[=+\-@\t\r]/.test(escaped);
  return `"${needsPrefix ? `'${escaped}` : escaped}"`;
}

/** The keys a zod object schema accepts, or null when it is not an object schema. */
function knownKeys(schema: z.ZodType<unknown>): Set<string> | null {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) return null;
  return new Set(Object.keys(shape));
}
