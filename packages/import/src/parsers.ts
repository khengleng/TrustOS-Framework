import { ApiError } from '@trustos/errors';

/**
 * Parsing uploaded files.
 *
 * CSV and JSON are implemented here. Excel and ZIP are **ports** — `FileParser` is the
 * interface, and a deployment that needs them supplies an adapter. That split is deliberate: a
 * spreadsheet parser is a large dependency with its own vulnerability history, and a framework
 * that pulled it in would impose it on every application including the ones that only ever
 * import CSV.
 *
 * The CSV parser is written here rather than taken from a library because an import file is
 * untrusted input, and the two things that matter most about it are not parsing features:
 *
 *   1. **A cell that begins with `=`, `+`, `-` or `@` is a formula to a spreadsheet.** If that
 *      value is later exported and opened in Excel, it executes. This is CSV injection, and it is
 *      the reason `@trustos/export` prefixes such values on the way out — see `escapeCsvCell`
 *      there. On the way *in*, the raw value is preserved and flagged, so a validator can decide.
 *   2. **A file is bounded.** Row count, cell size, column count. An import is a request an
 *      authenticated user makes, and an unbounded parse is an out-of-memory crash they can
 *      trigger at will.
 */

export interface ParsedRow {
  /** 1-based, counting the header as row 1 — so it matches what a spreadsheet shows. */
  rowNumber: number;
  values: Record<string, string>;
  /**
   * Cells whose text would be interpreted as a formula by a spreadsheet.
   *
   * Not an error here: a legitimate value can start with `-` (a negative number) or `+` (a phone
   * number). Reported so the validator can decide, and so the export side knows to escape it.
   */
  formulaCells: string[];
}

export interface ParseResult {
  columns: string[];
  rows: ParsedRow[];
  /** Rows the parser could not read at all. Reported rather than silently dropped. */
  malformed: Array<{ rowNumber: number; reason: string }>;
  truncated: boolean;
}

export interface ParseLimits {
  maxRows?: number;
  maxColumns?: number;
  maxCellLength?: number;
  maxBytes?: number;
}

export const DEFAULT_PARSE_LIMITS: Required<ParseLimits> = {
  /** 100k rows. Beyond this an import belongs in a job with a streaming parser. */
  maxRows: 100_000,
  maxColumns: 200,
  maxCellLength: 10_000,
  /** 50 MB. An import is a request an authenticated user makes; unbounded is an OOM they control. */
  maxBytes: 50 * 1024 * 1024,
};

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function looksLikeFormula(value: string): boolean {
  return value.length > 0 && FORMULA_PREFIXES.includes(value[0]!);
}

/** A parser for one file format. Excel and ZIP are supplied by a deployment, not the framework. */
export interface FileParser {
  /** e.g. `csv`, `xlsx`, `zip`. */
  readonly format: string;
  readonly contentTypes: string[];
  parse(content: Buffer, limits: Required<ParseLimits>): Promise<ParseResult>;
}

/**
 * CSV.
 *
 * RFC 4180 quoting: `"` opens a quoted field, `""` is a literal quote inside one, and a quoted
 * field may contain commas and newlines. A naive `split(',')` gets all three wrong, and the
 * failure mode is a row that silently shifts every column after the one containing a comma —
 * which then imports as valid data in the wrong fields.
 */
export class CsvParser implements FileParser {
  readonly format = 'csv';
  readonly contentTypes = ['text/csv', 'application/csv', 'text/plain'];

  constructor(private readonly delimiter = ',') {}

  async parse(content: Buffer, limits: Required<ParseLimits>): Promise<ParseResult> {
    if (content.byteLength > limits.maxBytes) {
      throw ApiError.validation(
        [
          {
            path: 'file',
            message:
              `The file is ${Math.round(content.byteLength / 1024 / 1024)} MB and the limit is ` +
              `${Math.round(limits.maxBytes / 1024 / 1024)} MB. Split it, or import it in batches.`,
          },
        ],
        'This file is too large to import.',
      );
    }

    // The BOM is stripped: Excel writes one, and left in place it becomes part of the first
    // column's name — so a header `id` silently becomes `\uFEFFid` and every row misses its
    // required field.
    const text = content.toString('utf8').replace(/^\uFEFF/, '');
    const records = this.splitRecords(text, limits);

    if (records.length === 0) {
      throw ApiError.validation(
        [{ path: 'file', message: 'The file is empty.' }],
        'This file has no rows.',
      );
    }

    const header = records[0]!;

    if (header.length > limits.maxColumns) {
      throw ApiError.validation(
        [
          {
            path: 'file',
            message: `The file has ${header.length} columns and the limit is ${limits.maxColumns}.`,
          },
        ],
        'This file has too many columns.',
      );
    }

    const columns = header.map((name, index) => normalizeColumn(name, index));
    assertUniqueColumns(columns);

    const rows: ParsedRow[] = [];
    const malformed: Array<{ rowNumber: number; reason: string }> = [];
    let truncated = false;

    for (let index = 1; index < records.length; index += 1) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        break;
      }

      const record = records[index]!;
      const rowNumber = index + 1;

      // A blank line is skipped rather than reported: trailing newlines are universal and
      // reporting each one as an error would bury the real problems.
      if (record.length === 1 && record[0]!.trim() === '') continue;

      if (record.length !== columns.length) {
        // Reported, never guessed at. Padding a short row would import empty strings as data and
        // truncating a long one would discard a value — both silently.
        malformed.push({
          rowNumber,
          reason: `Expected ${columns.length} values and found ${record.length}. The usual cause is an unescaped quote or comma.`,
        });
        continue;
      }

      const values: Record<string, string> = {};
      const formulaCells: string[] = [];
      let oversized: string | null = null;

      for (const [columnIndex, column] of columns.entries()) {
        const value = record[columnIndex] ?? '';

        if (value.length > limits.maxCellLength) {
          oversized = column;
          break;
        }

        values[column] = value;
        if (looksLikeFormula(value)) formulaCells.push(column);
      }

      if (oversized) {
        malformed.push({
          rowNumber,
          reason: `The value in "${oversized}" is longer than the ${limits.maxCellLength}-character limit.`,
        });
        continue;
      }

      rows.push({ rowNumber, values, formulaCells });
    }

    return { columns, rows, malformed, truncated };
  }

  /**
   * Splits into records and fields, honouring RFC 4180 quoting.
   *
   * A single pass over the characters. The state that matters is `inQuotes`: inside a quoted
   * field, a delimiter and a newline are literal text, and `""` is one quote character.
   */
  private splitRecords(text: string, limits: Required<ParseLimits>): string[][] {
    const records: string[][] = [];
    let record: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]!;

      if (inQuotes) {
        if (char === '"') {
          // `""` inside a quoted field is a literal quote; a lone `"` closes the field.
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
          continue;
        }
        field += char;
        continue;
      }

      if (char === '"' && field === '') {
        inQuotes = true;
        continue;
      }

      if (char === this.delimiter) {
        record.push(field);
        field = '';
        continue;
      }

      if (char === '\n' || char === '\r') {
        // `\r\n` is one break, not two. Treating it as two produces a blank record between every
        // real one for any file written on Windows.
        if (char === '\r' && text[index + 1] === '\n') index += 1;

        record.push(field);
        records.push(record);
        record = [];
        field = '';

        // One more than the limit, so the caller can tell "exactly at the limit" from "more than
        // the limit" and report truncation honestly.
        if (records.length > limits.maxRows + 1) break;
        continue;
      }

      field += char;
    }

    // The last record, when the file does not end with a newline.
    if (field !== '' || record.length > 0) {
      record.push(field);
      records.push(record);
    }

    return records;
  }
}

/**
 * JSON: an array of objects, or `{ "items": [...] }`.
 *
 * Both shapes, because both are what an API returns and an integrator will send whichever they
 * have. Values are stringified so the row shape matches CSV's — one validator then handles both
 * formats rather than two that drift apart.
 */
export class JsonParser implements FileParser {
  readonly format = 'json';
  readonly contentTypes = ['application/json', 'text/json'];

  async parse(content: Buffer, limits: Required<ParseLimits>): Promise<ParseResult> {
    if (content.byteLength > limits.maxBytes) {
      throw ApiError.validation(
        [{ path: 'file', message: 'The file is larger than the import limit.' }],
        'This file is too large to import.',
      );
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(content.toString('utf8'));
    } catch (error) {
      throw ApiError.validation(
        [
          {
            path: 'file',
            message: `The file is not valid JSON: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          },
        ],
        'This file could not be parsed.',
      );
    }

    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : null;

    if (!items) {
      throw ApiError.validation(
        [
          {
            path: 'file',
            message: 'Expected an array of objects, or an object with an "items" array.',
          },
        ],
        'This file is not in a shape the importer understands.',
      );
    }

    const rows: ParsedRow[] = [];
    const malformed: Array<{ rowNumber: number; reason: string }> = [];
    const columns = new Set<string>();
    let truncated = false;

    for (const [index, item] of items.entries()) {
      if (rows.length >= limits.maxRows) {
        truncated = true;
        break;
      }

      const rowNumber = index + 1;

      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        malformed.push({ rowNumber, reason: 'Expected an object.' });
        continue;
      }

      const values: Record<string, string> = {};
      const formulaCells: string[] = [];

      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        // Own properties only, and a reserved key is skipped — `__proto__` in a parsed JSON
        // object is inert, but the value flows into row objects that other code indexes.
        if (RESERVED_KEYS.has(key)) continue;

        columns.add(key);
        const text = stringifyValue(value);
        if (text.length > limits.maxCellLength) {
          malformed.push({
            rowNumber,
            reason: `The value in "${key}" is longer than the ${limits.maxCellLength}-character limit.`,
          });
          continue;
        }

        values[key] = text;
        if (looksLikeFormula(text)) formulaCells.push(key);
      }

      rows.push({ rowNumber, values, formulaCells });
    }

    return { columns: [...columns], rows, malformed, truncated };
  }
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/**
 * Normalizes a column name.
 *
 * Trimmed and lowercased, because `" Email "` and `"email"` are the same column to everybody
 * except a strict lookup — and an import that failed on "required field email missing" while the
 * file plainly had one is a support conversation nobody enjoys.
 */
function normalizeColumn(name: string, index: number): string {
  const trimmed = name.trim().toLowerCase().replace(/\s+/g, '_');
  return trimmed === '' ? `column_${index + 1}` : trimmed;
}

function assertUniqueColumns(columns: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const column of columns) {
    if (seen.has(column)) duplicates.add(column);
    seen.add(column);
  }

  if (duplicates.size > 0) {
    // Silently keeping the last would discard a column's data with no indication.
    throw ApiError.validation(
      [...duplicates].map((column) => ({
        path: 'file',
        message: `The column "${column}" appears more than once. Which one should be used is ambiguous.`,
      })),
      'This file has duplicate columns.',
    );
  }
}

/** Picks a parser by format or content type. */
export class ParserRegistry {
  private readonly parsers = new Map<string, FileParser>();

  constructor(parsers: FileParser[] = [new CsvParser(), new JsonParser()]) {
    for (const parser of parsers) this.register(parser);
  }

  register(parser: FileParser): this {
    this.parsers.set(parser.format, parser);
    return this;
  }

  get(format: string): FileParser {
    const parser = this.parsers.get(format.toLowerCase());

    if (!parser) {
      const known = [...this.parsers.keys()].sort().join(', ');
      throw ApiError.validation(
        [
          {
            path: 'format',
            message:
              `No parser is registered for "${format}". Available: ${known}. Excel and ZIP are ` +
              'ports — register an adapter if you need them.',
          },
        ],
        `Unsupported import format "${format}".`,
      );
    }

    return parser;
  }

  formats(): string[] {
    return [...this.parsers.keys()].sort();
  }
}
