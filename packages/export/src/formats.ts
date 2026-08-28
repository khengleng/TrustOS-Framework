import { ApiError } from '@trustos/errors';

/**
 * Export formats.
 *
 * CSV and JSON are implemented here. Excel and PDF are **ports** — the same reasoning as import:
 * both need substantial dependencies, and a framework that bundled them would impose a PDF engine
 * on every application that only ever exports CSV.
 *
 * The one thing this file exists to get right is `escapeCsvCell`. Everything else is
 * straightforward.
 */

/**
 * Escapes a value for a CSV cell.
 *
 * Two separate problems, and conflating them is how one of them gets missed:
 *
 * **1. CSV structure.** A value containing a comma, a quote or a newline must be quoted, with
 * internal quotes doubled. Skip this and a value with a comma shifts every column after it.
 *
 * **2. Spreadsheet formula injection.** A value beginning `=`, `+`, `-`, `@`, tab or carriage
 * return is a *formula* to Excel, LibreOffice and Google Sheets. `=cmd|' /C calc'!A0` in a cell
 * executes when the file is opened. The data came from a user — a customer name, a note field —
 * so this is a stored injection whose payload runs on the machine of whoever opens the export.
 *
 * The fix is to prefix such a value with `'`, which spreadsheets read as "this is text". It is
 * visible in the cell, which is the trade: a leading apostrophe on a value that genuinely starts
 * with `-` is mildly wrong, and executing a formula is catastrophically wrong.
 *
 * `stripFormulaPrefix` is available for an export that is definitely machine-read, and its
 * docstring says why reaching for it is usually a mistake.
 */
export function escapeCsvCell(value: unknown, options: { escapeFormulas?: boolean } = {}): string {
  const text = toText(value);
  const escapeFormulas = options.escapeFormulas !== false;

  const needsFormulaPrefix = escapeFormulas && /^[=+\-@\t\r]/.test(text);
  const prefixed = needsFormulaPrefix ? `'${text}` : text;

  // Quoting is decided on the *escaped* text, because adding the apostrophe cannot introduce a
  // structural character but the check must run over what is actually written.
  const needsQuoting = /[",\n\r]/.test(prefixed) || needsFormulaPrefix;

  return needsQuoting ? `"${prefixed.replace(/"/g, '""')}"` : prefixed;
}

/**
 * Removes a leading apostrophe added by `escapeCsvCell`.
 *
 * For re-importing an export machine-to-machine. Reaching for this on a file a person will open
 * is a mistake: it re-arms exactly the injection the prefix prevented, and the file looks
 * identical either way.
 */
export function stripFormulaPrefix(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? '';
}

export interface ExportColumn {
  /** The key in the row object. */
  key: string;
  /** The header text. Defaults to the key. */
  header?: string;
  /** Transforms the value. For formatting a date or resolving an id to a name. */
  format?: (value: unknown, row: Record<string, unknown>) => unknown;
}

/**
 * Writes rows in one format, incrementally.
 *
 * Incremental rather than "give me an array and I will return a string", because the whole point
 * of the export package is that a 500,000-row export must not be assembled in memory first.
 */
export interface ExportFormatter {
  readonly format: string;
  readonly contentType: string;
  readonly fileExtension: string;

  /** Called once. The CSV header row; JSON's opening bracket. */
  begin(columns: ExportColumn[]): string;
  /** Called per batch. */
  write(rows: Array<Record<string, unknown>>, columns: ExportColumn[]): string;
  /** Called once. JSON's closing bracket; nothing for CSV. */
  end(): string;
}

export class CsvFormatter implements ExportFormatter {
  readonly format = 'csv';
  readonly contentType = 'text/csv; charset=utf-8';
  readonly fileExtension = 'csv';

  constructor(private readonly options: { escapeFormulas?: boolean; delimiter?: string } = {}) {}

  begin(columns: ExportColumn[]): string {
    const delimiter = this.options.delimiter ?? ',';

    /*
     * A UTF-8 byte-order mark.
     *
     * Excel on Windows reads a CSV as the system code page unless it sees one, so a file with
     * Khmer or accented characters opens as mojibake. The BOM is three bytes that make the
     * difference between a usable export and a support ticket, and the import parser in
     * `@trustos/import` strips it.
     */
    return (
      '\uFEFF' +
      columns
        .map((column) => escapeCsvCell(column.header ?? column.key, this.options))
        .join(delimiter) +
      '\n'
    );
  }

  write(rows: Array<Record<string, unknown>>, columns: ExportColumn[]): string {
    const delimiter = this.options.delimiter ?? ',';

    return rows
      .map((row) =>
        columns
          .map((column) => {
            const raw = row[column.key];
            const value = column.format ? column.format(raw, row) : raw;
            return escapeCsvCell(value, this.options);
          })
          .join(delimiter),
      )
      .join('\n')
      .concat(rows.length > 0 ? '\n' : '');
  }

  end(): string {
    return '';
  }
}

/**
 * JSON, written as a stream.
 *
 * The brackets and commas are managed here rather than by serializing an array, so a large export
 * never holds every row at once — which is the whole reason this package exists.
 */
export class JsonFormatter implements ExportFormatter {
  readonly format = 'json';
  readonly contentType = 'application/json; charset=utf-8';
  readonly fileExtension = 'json';

  private wroteAny = false;

  begin(): string {
    this.wroteAny = false;
    return '{"items":[';
  }

  write(rows: Array<Record<string, unknown>>, columns: ExportColumn[]): string {
    if (rows.length === 0) return '';

    const serialized = rows.map((row) => {
      const projected: Record<string, unknown> = {};

      for (const column of columns) {
        const raw = row[column.key];
        projected[column.key] = column.format ? column.format(raw, row) : raw;
      }

      return JSON.stringify(projected);
    });

    // The separating comma belongs before this batch when something has already been written —
    // handling it here is what keeps the output valid without buffering.
    const prefix = this.wroteAny ? ',' : '';
    this.wroteAny = true;

    return prefix + serialized.join(',');
  }

  end(): string {
    return ']}';
  }
}

/**
 * Newline-delimited JSON.
 *
 * Worth having as a first-class option: every line is independently parseable, so a consumer can
 * stream a million rows without a streaming JSON parser, and a truncated file is still readable
 * up to the truncation. For a large machine-to-machine export it is the better choice.
 */
export class JsonLinesFormatter implements ExportFormatter {
  readonly format = 'jsonl';
  readonly contentType = 'application/x-ndjson';
  readonly fileExtension = 'jsonl';

  begin(): string {
    return '';
  }

  write(rows: Array<Record<string, unknown>>, columns: ExportColumn[]): string {
    return rows
      .map((row) => {
        const projected: Record<string, unknown> = {};
        for (const column of columns) {
          const raw = row[column.key];
          projected[column.key] = column.format ? column.format(raw, row) : raw;
        }
        return JSON.stringify(projected);
      })
      .join('\n')
      .concat(rows.length > 0 ? '\n' : '');
  }

  end(): string {
    return '';
  }
}

export class FormatterRegistry {
  private readonly formatters = new Map<string, ExportFormatter>();

  constructor(
    formatters: ExportFormatter[] = [
      new CsvFormatter(),
      new JsonFormatter(),
      new JsonLinesFormatter(),
    ],
  ) {
    for (const formatter of formatters) this.register(formatter);
  }

  register(formatter: ExportFormatter): this {
    this.formatters.set(formatter.format, formatter);
    return this;
  }

  get(format: string): ExportFormatter {
    const formatter = this.formatters.get(format.toLowerCase());

    if (!formatter) {
      throw ApiError.validation(
        [
          {
            path: 'format',
            message:
              `No formatter is registered for "${format}". Available: ` +
              `${[...this.formatters.keys()].sort().join(', ')}. Excel and PDF are ports — ` +
              'register an adapter if you need them.',
          },
        ],
        `Unsupported export format "${format}".`,
      );
    }

    return formatter;
  }

  formats(): string[] {
    return [...this.formatters.keys()].sort();
  }
}
