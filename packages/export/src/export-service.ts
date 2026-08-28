import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import type { ExportColumn, FormatterRegistry } from './formats';

/**
 * Running an export.
 *
 * One rule shapes everything here: **the rows are never all in memory at once.** A source yields
 * pages; the formatter writes each page; the sink receives the bytes. A 500,000-row export costs
 * one page of memory, not 500,000 rows of it.
 *
 * The three consequences worth knowing:
 *
 *   * **The source is a paging function**, not an array. `fetchPage(cursor, limit)`. Keyset
 *     paging, not `OFFSET` — see `ExportSource` for why that distinction is not pedantic.
 *   * **The sink is a port.** An HTTP response, a file, object storage. The service does not know
 *     which, so the same export can stream to a browser or land in a document.
 *   * **A row limit exists and is enforced.** An export is a query an authenticated user triggers,
 *     and an unbounded one is a way to read the whole database through a feature meant for a
 *     spreadsheet.
 */

export const EXPORT_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export interface ExportRun {
  id: string;
  organizationId: string | null;
  type: string;
  format: string;
  fileName: string;
  status: ExportStatus;
  rowCount: number;
  byteCount: number;
  /** Where the artefact ended up, when the sink produced one. */
  documentId: string | null;
  /** The filters the export ran with. For "what exactly did this file contain". */
  parameters: unknown;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdById: string | null;
}

export interface ExportPage {
  rows: Array<Record<string, unknown>>;
  /**
   * The cursor for the next page, or null at the end.
   *
   * A cursor rather than an offset. With `OFFSET`, a row inserted during the export shifts every
   * later page by one — so a row is silently skipped, and the export is quietly wrong in a way
   * nobody can detect from the file. Keyset paging (`WHERE id > $cursor ORDER BY id`) is stable
   * under concurrent writes, which for an export that takes minutes is not optional.
   */
  nextCursor: string | null;
}

export interface ExportSource<TParams = unknown> {
  type: string;
  description: string;
  columns: ExportColumn[];
  /**
   * Fetches one page.
   *
   * **Must filter by `organizationId`.** It is passed on every call and is not optional: an
   * export that ignored it would hand one tenant a file containing every tenant's data, which is
   * the worst single failure available in this package.
   */
  fetchPage(input: {
    organizationId: string | null;
    params: TParams;
    cursor: string | null;
    limit: number;
  }): Promise<ExportPage>;
  /** Rows this source may export in one run. Overrides the service default. */
  maxRows?: number;
}

/** Where the bytes go. An HTTP response, a file, object storage. */
export interface ExportSink {
  write(chunk: string): Promise<void>;
  /** Returns a document id when the sink stored something retrievable. */
  finish(): Promise<{ documentId: string | null }>;
  /** Called when the export fails, so a partial artefact can be discarded. */
  abort(error: Error): Promise<void>;
}

export interface ExportStore {
  create(run: ExportRun): Promise<ExportRun>;
  findById(id: string, organizationId: string | null): Promise<ExportRun | null>;
  update(id: string, patch: Partial<ExportRun>): Promise<void>;
  list(filter: {
    organizationId: string | null;
    type?: string;
    status?: ExportStatus;
    limit?: number;
    offset?: number;
  }): Promise<{ items: ExportRun[]; total: number }>;
}

export interface ExportServiceOptions {
  store: ExportStore;
  formatters: FormatterRegistry;
  sources?: ExportSource[];
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  /** Rows per page. Larger is fewer round trips and more memory per page. */
  pageSize?: number;
  /** Rows in one export, unless a source says otherwise. */
  maxRows?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

/** An export is a query an authenticated user triggers; unbounded is a way to read everything. */
export const DEFAULT_MAX_ROWS = 1_000_000;
export const DEFAULT_PAGE_SIZE = 1000;

export class ExportService {
  private readonly sources = new Map<string, ExportSource>();
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: ExportServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
    for (const source of options.sources ?? []) this.register(source);
  }

  register<TParams>(source: ExportSource<TParams>): this {
    if (this.sources.has(source.type)) {
      throw ApiError.conflict(`An export source for "${source.type}" is already registered.`, {
        reason: 'export_source_conflict',
        type: source.type,
      });
    }
    this.sources.set(source.type, source as ExportSource);
    return this;
  }

  private source(type: string): ExportSource {
    const source = this.sources.get(type);

    if (!source) {
      const known = [...this.sources.keys()].sort().join(', ') || '(none)';
      throw ApiError.validation(
        [{ path: 'type', message: `No export source for "${type}". Registered: ${known}.` }],
        `Unknown export type "${type}".`,
      );
    }

    return source;
  }

  /**
   * Runs an export, streaming into the sink.
   *
   * Page by page, and the whole point is what does *not* happen: no array of every row, no
   * concatenated string, no `JSON.stringify` over the result set.
   */
  async run(input: {
    type: string;
    format: string;
    organizationId: string | null;
    params?: unknown;
    sink: ExportSink;
    actorId: string | null;
    fileName?: string;
    /** Restricts the columns. Useful for an export that must not carry certain fields. */
    columns?: string[];
    signal?: AbortSignal;
    onProgress?: (rowCount: number) => void;
  }): Promise<ExportRun> {
    const source = this.source(input.type);
    const formatter = this.options.formatters.get(input.format);

    const columns = this.resolveColumns(source, input.columns);
    const maxRows = source.maxRows ?? this.options.maxRows ?? DEFAULT_MAX_ROWS;
    const pageSize = this.options.pageSize ?? DEFAULT_PAGE_SIZE;

    const fileName =
      input.fileName ??
      `${input.type.replace(/\./g, '-')}-${this.now().toISOString().slice(0, 10)}.${formatter.fileExtension}`;

    const run: ExportRun = {
      id: this.newId('exp'),
      organizationId: input.organizationId,
      type: input.type,
      format: input.format,
      fileName,
      status: 'running',
      rowCount: 0,
      byteCount: 0,
      documentId: null,
      parameters: input.params ?? null,
      error: null,
      startedAt: this.now(),
      completedAt: null,
      createdById: input.actorId,
    };

    await this.options.store.create(run);

    let rowCount = 0;
    let byteCount = 0;

    const emit = async (chunk: string) => {
      if (chunk.length === 0) return;
      byteCount += Buffer.byteLength(chunk, 'utf8');
      await input.sink.write(chunk);
    };

    try {
      await emit(formatter.begin(columns));

      let cursor: string | null = null;
      let truncated = false;

      for (;;) {
        if (input.signal?.aborted) {
          throw Object.assign(new Error('The export was cancelled.'), { name: 'AbortError' });
        }

        const remaining = maxRows - rowCount;
        if (remaining <= 0) {
          truncated = true;
          break;
        }

        const page: ExportPage = await source.fetchPage({
          organizationId: input.organizationId,
          params: input.params,
          cursor,
          limit: Math.min(pageSize, remaining),
        });

        if (page.rows.length > 0) {
          await emit(formatter.write(page.rows, columns));
          rowCount += page.rows.length;
          input.onProgress?.(rowCount);
        }

        if (!page.nextCursor) break;

        /*
         * A source that returns a cursor but no rows would loop forever.
         *
         * Stopping is the right response: continuing means an export that never finishes, holding
         * a connection and a sink open, and the symptom is a request that hangs rather than an
         * error anybody can act on.
         */
        if (page.rows.length === 0) {
          this.options.logger?.warn(
            { exportId: run.id, type: input.type, cursor },
            'export source returned a cursor with no rows; stopping to avoid an endless loop',
          );
          break;
        }

        cursor = page.nextCursor;
      }

      await emit(formatter.end());

      const { documentId } = await input.sink.finish();

      if (truncated) {
        // Recorded rather than only logged: somebody reading the file needs to know it is not the
        // whole answer, and the run record is where they will look.
        this.options.logger?.warn(
          { exportId: run.id, type: input.type, maxRows },
          'export reached its row limit and was truncated',
        );
      }

      const completed: Partial<ExportRun> = {
        status: 'completed',
        rowCount,
        byteCount,
        documentId,
        completedAt: this.now(),
        error: truncated
          ? `Truncated at the ${maxRows}-row limit. Narrow the filters, or export in batches.`
          : null,
      };

      await this.options.store.update(run.id, completed);

      await this.options.audit?.record({
        action: 'export.completed',
        entityType: 'ExportRun',
        entityId: run.id,
        actorId: input.actorId,
        organizationId: input.organizationId,
        // The parameters are recorded, because "what exactly did this file contain" is the
        // question asked when an export turns up somewhere it should not have.
        after: {
          type: input.type,
          format: input.format,
          rowCount,
          parameters: input.params ?? null,
        },
      });

      return { ...run, ...completed } as ExportRun;
    } catch (error) {
      const cancelled =
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: string }).name === 'AbortError';
      const message = error instanceof Error ? error.message : String(error);

      // The partial artefact is discarded. A half-written export left in storage is one somebody
      // will eventually download and treat as complete.
      await input.sink.abort(error instanceof Error ? error : new Error(message));

      await this.options.store.update(run.id, {
        status: cancelled ? 'cancelled' : 'failed',
        rowCount,
        byteCount,
        error: message,
        completedAt: this.now(),
      });

      this.options.logger?.error(
        { exportId: run.id, type: input.type, rowCount, error: message },
        cancelled ? 'export cancelled' : 'export failed',
      );

      throw error;
    }
  }

  /**
   * Estimates an export without running it.
   *
   * Fetches one page and reports the columns. For a UI that wants to say "this will export about
   * N rows" before committing a user to a five-minute download.
   */
  async preview(input: {
    type: string;
    organizationId: string | null;
    params?: unknown;
    limit?: number;
  }): Promise<{
    columns: ExportColumn[];
    sample: Array<Record<string, unknown>>;
    hasMore: boolean;
  }> {
    const source = this.source(input.type);

    const page = await source.fetchPage({
      organizationId: input.organizationId,
      params: input.params,
      cursor: null,
      limit: input.limit ?? 10,
    });

    return { columns: source.columns, sample: page.rows, hasMore: page.nextCursor !== null };
  }

  private resolveColumns(source: ExportSource, requested?: string[]): ExportColumn[] {
    if (!requested || requested.length === 0) return source.columns;

    const available = new Map(source.columns.map((column) => [column.key, column]));
    const resolved: ExportColumn[] = [];
    const unknown: string[] = [];

    for (const key of requested) {
      const column = available.get(key);
      // Only declared columns. Without this check, a caller could name any property that happened
      // to be on the row object — including one the source never meant to expose.
      if (column) resolved.push(column);
      else unknown.push(key);
    }

    if (unknown.length > 0) {
      throw ApiError.validation(
        unknown.map((key) => ({
          path: 'columns',
          message: `"${key}" is not a column of this export. Available: ${[...available.keys()].join(', ')}.`,
        })),
        'This export does not have those columns.',
      );
    }

    return resolved;
  }

  async get(id: string, organizationId: string | null): Promise<ExportRun> {
    const run = await this.options.store.findById(id, organizationId);
    if (!run) throw ApiError.notFound(`No export with id "${id}".`);
    return run;
  }

  async list(filter: Parameters<ExportStore['list']>[0]) {
    return this.options.store.list(filter);
  }

  types(): Array<{ type: string; description: string; columns: string[] }> {
    return [...this.sources.values()]
      .map((source) => ({
        type: source.type,
        description: source.description,
        columns: source.columns.map((column) => column.key),
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }
}

/** Collects into a string. For tests, and for an export small enough to hold. */
export class BufferSink implements ExportSink {
  private readonly chunks: string[] = [];
  aborted: Error | null = null;

  async write(chunk: string): Promise<void> {
    this.chunks.push(chunk);
  }

  async finish(): Promise<{ documentId: string | null }> {
    return { documentId: null };
  }

  async abort(error: Error): Promise<void> {
    this.aborted = error;
  }

  get content(): string {
    return this.chunks.join('');
  }
}
