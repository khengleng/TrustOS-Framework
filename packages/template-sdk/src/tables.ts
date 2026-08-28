import type { PermissionCheck } from './permissions';

/**
 * Tables.
 *
 * A column descriptor is data for the same reason a navigation item is: the server decides what a
 * user may see, and a table assembled in the browser cannot. A column carrying a salary or a
 * national ID must be absent from the *response*, not hidden with CSS — and the only way the API
 * and the grid agree on that is to read one list.
 *
 * Formatting lives here too. "Which timezone does this date render in" answered per screen gives
 * an application where two pages disagree about when something happened, and the support ticket
 * that follows is unanswerable.
 */

export type ColumnAlign = 'left' | 'right' | 'center';

export type ColumnFormat =
  'text' | 'date' | 'datetime' | 'money' | 'number' | 'boolean' | 'badge' | 'reference' | 'code';

export interface TableColumn {
  key: string;
  label: string;
  format?: ColumnFormat;
  /**
   * Alignment. Defaults follow the format: numbers and money right, everything else left.
   *
   * Right-aligned numerals line up their decimal points, which is the only way a column of
   * amounts can be scanned for an outlier.
   */
  align?: ColumnAlign;
  sortable?: boolean;
  /** Permission required to see this column at all. Enforced server-side by `visibleColumns`. */
  permission?: string;
  /** Hidden on narrow viewports. A hint to the renderer, never a security control. */
  secondary?: boolean;
  width?: string;
  /** For `money`: which field on the row holds the currency. Money without a currency is a number. */
  currencyKey?: string;
}

export interface TableDefinition {
  key: string;
  label: string;
  /** API path the rows come from, relative to the API root. */
  endpoint: string;
  description?: string;
  /** Shown instead of an empty grid. A blank table is indistinguishable from a broken one. */
  emptyHint?: string;
  columns: TableColumn[];
  defaultSort?: SortSpec;
  /** Permission required to open the screen at all. */
  permission?: string;
}

export interface SortSpec {
  key: string;
  direction: 'asc' | 'desc';
}

export function defaultAlign(column: TableColumn): ColumnAlign {
  if (column.align) return column.align;
  return column.format === 'money' || column.format === 'number' ? 'right' : 'left';
}

/**
 * The columns an actor may see.
 *
 * Call this on the server and project the rows through `pickColumns` before responding. Calling
 * it only in the browser produces a table that looks correct and a payload that is not.
 */
export function visibleColumns(table: TableDefinition, can: PermissionCheck): TableColumn[] {
  return table.columns.filter((column) => !column.permission || can(column.permission));
}

/** Narrows a row to the given columns. The projection that makes `visibleColumns` mean something. */
export function pickColumns<T extends Record<string, unknown>>(
  row: T,
  columns: TableColumn[],
): Partial<T> {
  const keys = new Set(columns.map((column) => column.key));
  return Object.fromEntries(Object.entries(row).filter(([key]) => keys.has(key))) as Partial<T>;
}

/**
 * Validates a requested sort against the table.
 *
 * Returns the default sort when the request names a column that does not exist or is not
 * sortable. Refusing outright would turn a stale bookmark into an error page; silently accepting
 * would pass an arbitrary caller-supplied string to the query builder, which is how a sort
 * parameter becomes an injection point.
 */
export function resolveSort(table: TableDefinition, requested?: Partial<SortSpec>): SortSpec {
  const fallback: SortSpec = table.defaultSort ?? { key: 'createdAt', direction: 'desc' };

  if (!requested?.key) return fallback;

  const column = table.columns.find((entry) => entry.key === requested.key);
  if (!column?.sortable) return fallback;

  return { key: column.key, direction: requested.direction === 'asc' ? 'asc' : 'desc' };
}
