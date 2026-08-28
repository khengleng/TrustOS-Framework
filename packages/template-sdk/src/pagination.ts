import { z } from 'zod';
import { ApiError } from '@trustos/errors';

/**
 * Pagination.
 *
 * Both kinds, because they fail differently and templates need both.
 *
 * **Offset** (`page` / `pageSize`) is what a human-driven admin table wants: people expect to
 * jump to page 7 and to be told there are 340 results. It is wrong under concurrent writes — a
 * row inserted while you page shifts everything down by one and you see a record twice — and for
 * a list a person is reading, that is a cosmetic problem.
 *
 * **Cursor** is what an export or a sync job wants: it cannot skip or repeat a record, because
 * the cursor names the last row seen rather than a position that moves. It cannot count, and it
 * cannot jump. A reconciliation run that silently skipped a payment because the page boundary
 * moved is the failure this exists to prevent.
 *
 * The rule this SDK encodes: **people get offset, machines get cursor.** A template that pages a
 * settlement file with `page=2` is a bug the reviewer should catch on sight.
 */

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 25;

export const offsetQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type OffsetQuery = z.infer<typeof offsetQuerySchema>;

export const cursorQuerySchema = z
  .object({
    /** Opaque to the caller: the id of the last row of the previous page. */
    cursor: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export interface OffsetPage<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface CursorPage<T> {
  rows: T[];
  /** Pass back as `cursor` for the next page. Null when the end has been reached. */
  nextCursor: string | null;
  hasNext: boolean;
}

/** `skip` and `take` for a Prisma query. */
export function toSkipTake(query: OffsetQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/**
 * Assembles an offset page.
 *
 * A page past the end returns no rows rather than throwing. A bookmark to page 9 of a list that
 * has shrunk to 3 pages is not an error the user can act on; an empty page with `hasPrevious`
 * set lets them get back.
 */
export function buildOffsetPage<T>(rows: T[], total: number, query: OffsetQuery): OffsetPage<T> {
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));

  return {
    rows,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages,
    hasNext: query.page < totalPages,
    hasPrevious: query.page > 1,
  };
}

/**
 * Assembles a cursor page from `limit + 1` rows.
 *
 * Fetching one extra row is how `hasNext` is answered without a second count query — and a count
 * on a large table is the query that makes a list endpoint slow.
 */
export function buildCursorPage<T extends { id: string }>(
  fetched: T[],
  query: CursorQuery,
): CursorPage<T> {
  const hasNext = fetched.length > query.limit;
  const rows = hasNext ? fetched.slice(0, query.limit) : fetched;
  const last = rows[rows.length - 1];

  return { rows, nextCursor: hasNext && last ? last.id : null, hasNext };
}

/** The `take` to pass to the query: one more than asked for. See `buildCursorPage`. */
export function cursorTake(query: CursorQuery): number {
  return query.limit + 1;
}

/**
 * Refuses a page size a caller tried to raise past the ceiling.
 *
 * `offsetQuerySchema` already caps it, so this is for the hand-rolled path — and it throws rather
 * than clamping, because a caller asking for 10,000 rows is a caller who will keep asking. A
 * silently clamped response looks like a short page and gets retried forever.
 */
export function assertPageSize(size: number, max: number = MAX_PAGE_SIZE): void {
  if (size >= 1 && size <= max) return;

  throw ApiError.validation(
    [
      {
        path: 'pageSize',
        message: `Page size must be between 1 and ${max}; received ${size}.`,
        code: 'page_size_out_of_range',
      },
    ],
    'Invalid page size.',
  );
}
