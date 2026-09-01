import { scopedDelegate } from '@trustsystem/tenancy';
import { z } from 'zod';

/**
 * Searchable sources.
 *
 * An adapter is one thing a caller can search — merchants, documents, payouts.
 * Each declares the permission a caller must hold, and the service never returns
 * a hit from a source the caller cannot read. That is the whole authorization
 * model, and it is what makes a single global search box safe to put in front of
 * an organization with mixed roles.
 *
 * There is no index. Adapters query what the owning module already stores, which
 * means a hit is always as current as the row and there is no second copy of
 * customer data to keep tenant-correct.
 */

export interface SearchHit {
  /** Row id, for the caller to follow. */
  id: string;
  /** The organization the row belongs to. Verified by the service. */
  organizationId: string;
  /** Adapter that produced the hit. */
  source: string;
  title: string;
  /** Short context, already truncated by the adapter. */
  snippet: string | null;
  /** Fields that matched, keyed by field name. Used by the ranker. */
  matched: Record<string, string>;
  /** Adapter-supplied importance, 0..1. Optional input to ranking. */
  weight?: number;
}

export interface SearchAdapterQuery {
  term: string;
  organizationId: string;
  limit: number;
}

export interface SearchAdapter {
  /** Stable id, used in results and in `GET /search/sources`. */
  readonly id: string;
  /** Human label for the source. */
  readonly label: string;
  /** Permission a caller must hold for this source to be searched at all. */
  readonly permission: string;
  search(query: SearchAdapterQuery): Promise<SearchHit[]>;
}

export const searchTermSchema = z
  .string()
  .trim()
  .min(2, 'Search for at least two characters.')
  .max(120);

/**
 * A database-backed adapter over one Prisma model.
 *
 * Two properties are worth stating:
 *
 *   * The delegate is wrapped by `scopedDelegate`, so the query carries the
 *     organization whether or not the adapter remembers to add it.
 *   * The term is passed to Prisma as a `contains` argument, not interpolated
 *     into a string. There is no SQL for a term to break out of, and `%` or `_`
 *     in a search term is a literal character rather than a wildcard.
 */
export function createPrismaSearchAdapter(options: {
  id: string;
  label: string;
  permission: string;
  /** Prisma model delegate, unscoped; wrapped here. */
  delegate: () => object;
  /** Fields searched, in descending order of importance. */
  fields: string[];
  /** Field used as the result title. Defaults to the first searched field. */
  titleField?: string;
  /** Field used as the snippet. */
  snippetField?: string;
}): SearchAdapter {
  const titleField = options.titleField ?? options.fields[0] ?? 'id';

  return {
    id: options.id,
    label: options.label,
    permission: options.permission,

    async search(query: SearchAdapterQuery): Promise<SearchHit[]> {
      const delegate = scopedDelegate(options.delegate(), { model: options.id }) as unknown as {
        findMany(args?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
      };

      const rows = await delegate.findMany({
        where: {
          deletedAt: null,
          OR: options.fields.map((field) => ({
            [field]: { contains: query.term, mode: 'insensitive' },
          })),
        },
        take: query.limit,
        orderBy: { createdAt: 'desc' },
      });

      return rows.map((row) => ({
        id: String(row.id ?? ''),
        organizationId: String(row.organizationId ?? ''),
        source: options.id,
        title: String(row[titleField] ?? ''),
        snippet: options.snippetField ? stringOrNull(row[options.snippetField]) : null,
        matched: matchedFields(row, options.fields, query.term),
      }));
    },
  };
}

/** A fixed-row adapter. Used by tests and by static reference data. */
export function createStaticSearchAdapter(options: {
  id: string;
  label: string;
  permission: string;
  rows: Array<{ id: string; organizationId: string; [field: string]: string }>;
  fields: string[];
  titleField?: string;
}): SearchAdapter {
  const titleField = options.titleField ?? options.fields[0] ?? 'id';

  return {
    id: options.id,
    label: options.label,
    permission: options.permission,

    async search(query: SearchAdapterQuery): Promise<SearchHit[]> {
      const term = query.term.toLowerCase();

      return options.rows
        .filter((row) => row.organizationId === query.organizationId)
        .filter((row) =>
          options.fields.some((field) =>
            String(row[field] ?? '')
              .toLowerCase()
              .includes(term),
          ),
        )
        .slice(0, query.limit)
        .map((row) => ({
          id: row.id,
          organizationId: row.organizationId,
          source: options.id,
          title: String(row[titleField] ?? ''),
          snippet: null,
          matched: matchedFields(row, options.fields, query.term),
        }));
    },
  };
}

function matchedFields(
  row: Record<string, unknown>,
  fields: string[],
  term: string,
): Record<string, string> {
  const lowered = term.toLowerCase();
  const matched: Record<string, string> = {};

  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'string' && value.toLowerCase().includes(lowered)) {
      matched[field] = value;
    }
  }
  return matched;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 240) : null;
}
