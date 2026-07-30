import { ApiError } from '@trustos/errors';
import type { ReportColumn } from './report';

/**
 * Export formats.
 *
 * CSV is implemented. PDF is a port with no implementation, and the shipped
 * renderer refuses loudly rather than producing an empty file — a zero-byte PDF
 * that downloads successfully is the worst of the three possible behaviours.
 */

export const EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportResult {
  format: ExportFormat;
  contentType: string;
  filename: string;
  content: Buffer;
}

/**
 * Cell prefixes that make a spreadsheet treat the value as a formula.
 *
 * `=cmd|' /c calc'!A1` in a CSV opened in Excel is remote code execution on the
 * machine of whoever opened the export. The value is customer data — a merchant
 * name, a description — so it must be neutralised on the way out. Prefixing with
 * an apostrophe is the standard mitigation: the spreadsheet shows the original
 * text and does not evaluate it.
 */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r', '\n'];

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const raw = value instanceof Date ? value.toISOString() : String(value);
  const neutralised = FORMULA_PREFIXES.some((prefix) => raw.startsWith(prefix)) ? `'${raw}` : raw;

  // Quote when the cell contains a delimiter, a quote or a line break, doubling
  // any embedded quote — RFC 4180.
  if (/[",\r\n]/.test(neutralised)) {
    return `"${neutralised.replace(/"/g, '""')}"`;
  }
  return neutralised;
}

/**
 * Renders rows as CSV.
 *
 * Column order comes from the definition, not from the shape of the first row: a
 * row missing an optional field would otherwise shift every later column, which
 * is the kind of corruption nobody notices until a reconciliation fails.
 */
export function toCsv(columns: ReportColumn[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map((column) => escapeCsvCell(column.label)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCsvCell(row[column.key])).join(','));

  // CRLF: the line ending RFC 4180 specifies, and the one Excel expects.
  return [header, ...body].join('\r\n');
}

/**
 * Turns a report id into a safe filename.
 *
 * A report id is declared in code rather than supplied by a caller, but the
 * filename crosses into a `Content-Disposition` header, and a newline there is a
 * response-splitting primitive. Sanitising costs one line.
 */
export function exportFilename(reportId: string, format: ExportFormat, generatedAt: Date): string {
  const safeId = reportId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60) || 'report';
  const stamp = generatedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${safeId}-${stamp}.${format}`;
}

/**
 * PDF rendering.
 *
 * A port only. Implementing it means choosing a rendering stack — headless
 * Chromium, a PDF library, a rendering service — and that choice belongs to the
 * product, not to a framework module.
 */
export interface PdfRenderer {
  readonly id: string;
  render(input: {
    title: string;
    columns: ReportColumn[];
    rows: Array<Record<string, unknown>>;
  }): Promise<Buffer>;
}

export class UnavailablePdfRenderer implements PdfRenderer {
  readonly id = 'unavailable';

  async render(): Promise<Buffer> {
    throw new ApiError('internal_error', {
      message: 'PDF export is not configured for this application.',
      context: {
        reason: 'pdf_renderer_not_configured',
        remedy: 'Provide a PdfRenderer when creating the reporting module.',
      },
    });
  }
}
