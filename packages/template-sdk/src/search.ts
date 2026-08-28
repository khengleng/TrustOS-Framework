import { ApiError } from '@trustos/errors';

/**
 * Search.
 *
 * The same trust boundary as `filters.ts`, with one extra hazard: search is the box where users
 * type anything, so it is the box attackers type into first.
 *
 * Three rules, all enforced here rather than trusted to callers:
 *
 *   1. **The template declares which fields are searchable.** A free-text box that searches
 *      "every string column" eventually searches a column somebody added that holds a token.
 *   2. **A term is data, never syntax.** The output is a Prisma `contains` fragment with the term
 *      as a bound value. Nothing here builds SQL.
 *   3. **Terms are bounded.** A 50kB term across eight columns of a million-row table is a
 *      denial of service that costs the attacker one request.
 *
 * What this is not: a search engine. There is no ranking, no stemming, no index. It is a
 * `contains` across declared columns, which is the right amount of search for an admin table and
 * the wrong amount for a product catalogue — a template that needs real search should reach for
 * a real index and say so in its manifest.
 */

export const MAX_SEARCH_LENGTH = 100;
export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_TOKENS = 6;

export interface SearchableField {
  key: string;
  label: string;
  /**
   * Match from the start of the value rather than anywhere inside it.
   *
   * Worth setting for a code or reference column: `startsWith` can use an index, `contains`
   * cannot, and on a reference number a prefix is what people actually type.
   */
  prefixOnly?: boolean;
  permission?: string;
}

export interface SearchDefinition {
  /** Fields the free-text box searches. Empty means the resource is not searchable. */
  fields: SearchableField[];
  placeholder?: string;
}

/**
 * Normalizes a raw search term.
 *
 * Returns null for a term too short to be worth running — one character across eight columns
 * matches most of the table, which is a slow way of showing the user what they already had.
 */
export function normalizeSearchTerm(raw: string | undefined | null): string | null {
  if (!raw) return null;

  const trimmed = raw.trim().replace(/\s+/g, ' ');

  if (trimmed.length === 0) return null;

  if (trimmed.length > MAX_SEARCH_LENGTH) {
    throw ApiError.validation(
      [
        {
          path: 'q',
          message: `Search terms are limited to ${MAX_SEARCH_LENGTH} characters.`,
          code: 'search_term_too_long',
        },
      ],
      'Search term too long.',
    );
  }

  return trimmed.length < MIN_SEARCH_LENGTH ? null : trimmed;
}

/**
 * Splits a term into tokens, all of which must match somewhere.
 *
 * "dara phnom" finds the Dara in Phnom Penh rather than everyone called Dara plus everyone in
 * Phnom Penh — which is what a single `contains` of the whole string cannot do and what users
 * expect from any search box they have ever used.
 */
export function tokenize(term: string): string[] {
  return term
    .split(' ')
    .filter((token) => token.length >= MIN_SEARCH_LENGTH)
    .slice(0, MAX_SEARCH_TOKENS);
}

/**
 * A Prisma `where` fragment: every token must match at least one searchable field.
 *
 * `AND` of `OR`s. The other way round — `OR` of `AND`s — requires every token in the *same*
 * field, so a customer name in one column and a city in another never match together.
 *
 * Returns an empty object for a term that normalizes away, which is a `where` that filters
 * nothing rather than one that matches nothing. A search box cleared by the user should show the
 * whole list back.
 */
export function toSearchWhere(
  definition: SearchDefinition,
  term: string | null,
  can: (permission: string) => boolean = () => true,
): Record<string, unknown> {
  if (!term) return {};

  const fields = definition.fields.filter((field) => !field.permission || can(field.permission));
  if (fields.length === 0) return {};

  const tokens = tokenize(term);
  if (tokens.length === 0) return {};

  return {
    AND: tokens.map((token) => ({
      OR: fields.map((field) => ({
        [field.key]: field.prefixOnly
          ? { startsWith: token, mode: 'insensitive' }
          : { contains: token, mode: 'insensitive' },
      })),
    })),
  };
}

/**
 * Escapes the characters that mean something to a SQL `LIKE`.
 *
 * Prisma parameterizes `contains`, so this is not needed on that path — it is here for the
 * template that drops to `$queryRaw` for a query Prisma cannot express. Without it, a user
 * searching for `100%` matches every row, and one searching `_` matches every row of every
 * length, which reads as "search is broken" rather than as the injection-adjacent bug it is.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}
