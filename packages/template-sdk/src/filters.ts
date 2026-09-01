import { ApiError } from '@trustsystem/errors';

/**
 * Filters.
 *
 * This file is a trust boundary, and it is worth being explicit about why. A filter is a caller
 * saying "restrict the query by this field, with this operator, to this value" — three pieces of
 * attacker-controlled input that end up in a database query. The naive implementation spreads the
 * parsed query string into a Prisma `where`, which lets a caller filter on `passwordHash`, or
 * pass `{ not: null }` where a string was expected, or reach a relation the screen never
 * exposed.
 *
 * So nothing here is derived from the request. The **template declares** which fields are
 * filterable and with which operators; a request that names anything else is refused by name,
 * loudly, rather than ignored. An ignored filter is worse than a rejected one: the caller
 * believes the result set was narrowed and it was not, and on a screen showing one branch's
 * takings that is a disclosure.
 */

export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'contains'
  | 'startsWith'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isNull';

export type FilterValueType = 'string' | 'number' | 'boolean' | 'date' | 'enum';

export interface FilterDefinition {
  key: string;
  label: string;
  type: FilterValueType;
  /** Operators this field accepts. A field is filterable only by what it declares. */
  operators: FilterOperator[];
  /** `enum` only: the permitted values. Anything else is refused. */
  options?: Array<{ value: string; label: string }>;
  /** Permission required to use this filter at all. */
  permission?: string;
}

export interface AppliedFilter {
  key: string;
  operator: FilterOperator;
  value: unknown;
}

/** Operators that are meaningful for each value type. Enforced by `parseFilters`. */
const OPERATORS_BY_TYPE: Record<FilterValueType, FilterOperator[]> = {
  string: ['eq', 'ne', 'contains', 'startsWith', 'in', 'isNull'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'isNull'],
  boolean: ['eq', 'isNull'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull'],
  enum: ['eq', 'ne', 'in', 'isNull'],
};

/** Longest a `contains` term may be. A 10kB substring scan is a denial of service, not a search. */
const MAX_TERM_LENGTH = 200;

/** Most values an `in` list may carry. */
const MAX_IN_VALUES = 50;

/**
 * Validates requested filters against the declared set.
 *
 * Throws on the first problem with a message naming the offending key. Callers building a screen
 * see exactly which filter they got wrong; callers probing for a field that exists learn only
 * that it is not filterable, which is the same answer they get for a field that does not exist.
 */
export function parseFilters(
  declared: FilterDefinition[],
  requested: AppliedFilter[],
  can: (permission: string) => boolean = () => true,
): AppliedFilter[] {
  const byKey = new Map(declared.map((filter) => [filter.key, filter]));
  const parsed: AppliedFilter[] = [];

  for (const filter of requested) {
    const definition = byKey.get(filter.key);

    if (!definition) {
      throw ApiError.validation(
        [
          {
            path: `filter.${filter.key}`,
            message:
              `"${filter.key}" is not a filterable field on this resource. Filterable: ` +
              `${declared.map((entry) => entry.key).join(', ') || 'none'}.`,
            code: 'filter_not_allowed',
          },
        ],
        'Unsupported filter.',
      );
    }

    if (definition.permission && !can(definition.permission)) {
      /*
       * Same message as an undeclared field, on purpose. Telling an unauthorized caller that the
       * field exists but is not theirs confirms the field exists.
       */
      throw ApiError.validation(
        [
          {
            path: `filter.${filter.key}`,
            message: `"${filter.key}" is not a filterable field on this resource.`,
            code: 'filter_not_allowed',
          },
        ],
        'Unsupported filter.',
      );
    }

    if (!definition.operators.includes(filter.operator)) {
      throw ApiError.validation(
        [
          {
            path: `filter.${filter.key}`,
            message:
              `Operator "${filter.operator}" is not allowed on "${filter.key}". Allowed: ` +
              `${definition.operators.join(', ')}.`,
            code: 'operator_not_allowed',
          },
        ],
        'Unsupported filter operator.',
      );
    }

    if (!OPERATORS_BY_TYPE[definition.type].includes(filter.operator)) {
      throw ApiError.validation(
        [
          {
            path: `filter.${filter.key}`,
            message: `Operator "${filter.operator}" is meaningless on a ${definition.type} field.`,
            code: 'operator_not_applicable',
          },
        ],
        'Unsupported filter operator.',
      );
    }

    parsed.push({ ...filter, value: coerceValue(definition, filter) });
  }

  return parsed;
}

function coerceValue(definition: FilterDefinition, filter: AppliedFilter): unknown {
  if (filter.operator === 'isNull') return Boolean(filter.value);

  if (filter.operator === 'in') {
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];

    if (values.length === 0 || values.length > MAX_IN_VALUES) {
      throw invalid(
        definition,
        `An "in" filter needs between 1 and ${MAX_IN_VALUES} values; received ${values.length}.`,
      );
    }

    return values.map((value) => coerceScalar(definition, value));
  }

  if (filter.operator === 'between') {
    const values = Array.isArray(filter.value) ? filter.value : [];

    if (values.length !== 2) {
      throw invalid(definition, 'A "between" filter needs exactly two values: [from, to].');
    }

    const [from, to] = values.map((value) => coerceScalar(definition, value));

    if (from !== null && to !== null && (from as number) > (to as number)) {
      // Refused rather than swapped: a reversed range is usually two bound variables crossed
      // somewhere upstream, and silently correcting it hides the real bug.
      throw invalid(definition, 'A "between" filter needs "from" to be at or before "to".');
    }

    return [from, to];
  }

  return coerceScalar(definition, filter.value);
}

function coerceScalar(definition: FilterDefinition, value: unknown): unknown {
  switch (definition.type) {
    case 'string': {
      if (typeof value !== 'string') throw invalid(definition, 'Expected a string.');
      if (value.length > MAX_TERM_LENGTH) {
        throw invalid(definition, `Value must be at most ${MAX_TERM_LENGTH} characters.`);
      }
      return value.trim();
    }

    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) throw invalid(definition, 'Expected a number.');
      return parsed;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw invalid(definition, 'Expected true or false.');
    }

    case 'date': {
      const parsed = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(parsed.getTime())) throw invalid(definition, 'Expected a date.');
      return parsed;
    }

    case 'enum': {
      const allowed = (definition.options ?? []).map((option) => option.value);
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw invalid(definition, `Expected one of: ${allowed.join(', ')}.`);
      }
      return value;
    }
  }
}

function invalid(definition: FilterDefinition, message: string): ApiError {
  return ApiError.validation(
    [{ path: `filter.${definition.key}`, message, code: 'filter_invalid_value' }],
    'Invalid filter value.',
  );
}

/**
 * Translates validated filters into a Prisma `where` fragment.
 *
 * Safe only because every key reaching it has been matched against a declared definition — this
 * function trusts its input and `parseFilters` is what earns that trust. Never call it with
 * anything that did not come through there.
 */
export function toPrismaWhere(filters: AppliedFilter[]): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  for (const filter of filters) {
    switch (filter.operator) {
      case 'eq':
        where[filter.key] = filter.value;
        break;
      case 'ne':
        where[filter.key] = { not: filter.value };
        break;
      case 'contains':
        where[filter.key] = { contains: filter.value, mode: 'insensitive' };
        break;
      case 'startsWith':
        where[filter.key] = { startsWith: filter.value, mode: 'insensitive' };
        break;
      case 'in':
        where[filter.key] = { in: filter.value };
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        where[filter.key] = { [filter.operator]: filter.value };
        break;
      case 'between': {
        const [from, to] = filter.value as [unknown, unknown];
        where[filter.key] = { gte: from, lte: to };
        break;
      }
      case 'isNull':
        where[filter.key] = filter.value ? null : { not: null };
        break;
    }
  }

  return where;
}

/**
 * Parses `?filter[status]=eq:ACTIVE&filter[amount]=between:10,90` into filters.
 *
 * A flat query-string encoding rather than JSON, because a filter that survives being copied out
 * of a browser address bar into a bug report is a filter that can be reproduced.
 */
export function parseFilterQuery(query: Record<string, string | string[]>): AppliedFilter[] {
  const filters: AppliedFilter[] = [];

  for (const [rawKey, rawValue] of Object.entries(query)) {
    const match = /^filter\[([A-Za-z0-9_.]+)\]$/.exec(rawKey);
    if (!match?.[1]) continue;

    const values = Array.isArray(rawValue) ? rawValue : [rawValue];

    for (const value of values) {
      const separator = value.indexOf(':');
      const operator = (separator === -1 ? 'eq' : value.slice(0, separator)) as FilterOperator;
      const payload = separator === -1 ? value : value.slice(separator + 1);

      filters.push({
        key: match[1],
        operator,
        value:
          operator === 'in' || operator === 'between'
            ? payload.split(',').map((part) => part.trim())
            : payload,
      });
    }
  }

  return filters;
}
