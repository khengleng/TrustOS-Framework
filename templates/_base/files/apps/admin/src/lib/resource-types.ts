/**
 * Resource registry types.
 *
 * A product describes its screens as data in `resources.ts`; one generic page
 * renders all of them. That keeps the admin console small — adding an entity
 * is an entry in a list, not another near-identical page component — and means
 * every screen gets the same loading, empty and error handling for free.
 */

export interface ResourceColumn {
  /** Key on the row object. Dotted paths are resolved: "user.email". */
  key: string;
  label: string;
  /** Rendered as a pill rather than plain text. Good for statuses. */
  badge?: boolean;
  /** Formatted as a local date-time. */
  date?: boolean;
}

export interface ResourceDefinition {
  /** URL segment: /resources/<key>. */
  key: string;
  label: string;
  /** API path relative to the base URL, e.g. "/stores". */
  endpoint: string;
  description?: string;
  columns: ResourceColumn[];
  /** Shown when the list is empty. Say what to do, not just that it is empty. */
  emptyHint?: string;
}

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
