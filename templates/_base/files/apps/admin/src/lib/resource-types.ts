/**
 * Resource registry types.
 *
 * A product describes its screens as data in `resources.ts`; one generic page renders all of
 * them. That keeps the admin console small — adding an entity is an entry in a list, not another
 * near-identical page component — and means every screen gets the same loading, empty and error
 * handling for free.
 *
 * The shape comes from `@trustsystem/template-sdk`, and it is the *same* declaration the API reads to
 * decide which columns a caller may see and which filters it will accept. That is the whole point:
 * a table described twice is a table where a field added to one description is missing from the
 * other, and the version somebody notices is always the wrong one.
 */

export type {
  ResourceDefinition,
  TableColumn,
  TableDefinition,
  ColumnFormat,
} from '@trustsystem/template-sdk';

export { defaultAlign } from '@trustsystem/template-sdk';

/** Resolves "user.email" against a row. */
export function readCell(row: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
      row,
    );
}

/**
 * How a cell should be rendered.
 *
 * Derived from the column's `format` rather than from the value: a string that happens to parse
 * as a date is not a date, and a column that renders as one on Tuesday and as text on Wednesday
 * is a bug nobody can reproduce.
 */
export function cellKind(format: string | undefined): 'badge' | 'date' | 'money' | 'text' {
  if (format === 'badge') return 'badge';
  if (format === 'date' || format === 'datetime') return 'date';
  if (format === 'money') return 'money';
  return 'text';
}
