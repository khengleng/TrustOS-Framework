import { ApiError } from '@trustos/errors';

/**
 * Event name patterns.
 *
 * A subscriber says which events it wants, and saying it one name at a time does not survive
 * contact with a system that has forty of them. So: `workflow.*` matches one segment,
 * `workflow.**` matches the rest, `*` alone matches everything.
 *
 * Two segment wildcards rather than one regex, deliberately. A regex from a subscription request
 * is a denial of service waiting for the right nested quantifier — the classic catastrophic
 * backtracking case — and the pattern here is compiled by walking segments, which cannot
 * backtrack at all.
 */

const SEGMENT = /^(\*|\*\*|[a-z][a-z0-9_]*)$/;

export function assertValidPattern(pattern: string): void {
  if (pattern.length === 0 || pattern.length > 200) {
    throw ApiError.validation(
      [{ path: 'pattern', message: 'A pattern is between 1 and 200 characters.' }],
      'Invalid event pattern.',
    );
  }

  const segments = pattern.split('.');

  for (const [index, segment] of segments.entries()) {
    if (!SEGMENT.test(segment)) {
      throw ApiError.validation(
        [
          {
            path: 'pattern',
            message:
              `Segment "${segment}" is not valid. A segment is lowercase, or "*" for one ` +
              'segment, or "**" for the remainder.',
          },
        ],
        `"${pattern}" is not a valid event pattern.`,
      );
    }

    // `**` in the middle would make matching ambiguous — `a.**.c` could split more than one way,
    // and resolving that needs the backtracking this design exists to avoid.
    if (segment === '**' && index !== segments.length - 1) {
      throw ApiError.validation(
        [{ path: 'pattern', message: '"**" is only valid as the final segment.' }],
        `"${pattern}" is not a valid event pattern.`,
      );
    }
  }
}

/**
 * Whether an event name matches a pattern.
 *
 * A single linear walk. No regex is built, so a pattern from an untrusted subscription request
 * costs the same as any other.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern === '*' || pattern === '**') return true;

  const nameSegments = name.split('.');
  const patternSegments = pattern.split('.');

  for (const [index, patternSegment] of patternSegments.entries()) {
    if (patternSegment === '**') {
      // Matches the remainder — but there must *be* a remainder: `a.**` does not match `a`,
      // because a subscriber asking for everything under `a` is asking about its children.
      return nameSegments.length > index;
    }

    const nameSegment = nameSegments[index];
    if (nameSegment === undefined) return false;
    if (patternSegment === '*') continue;
    if (patternSegment !== nameSegment) return false;
  }

  // Every pattern segment matched; the name must not have extra ones. `a.b` does not match
  // `a.b.c` — a subscriber to `workflow.task` should not receive `workflow.task.comment.added`
  // without saying so.
  return nameSegments.length === patternSegments.length;
}

/** Whether any of the patterns matches. The subscription-level question. */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPattern(name, pattern));
}

/**
 * How specific a pattern is, for ordering.
 *
 * An exact name outranks `workflow.*`, which outranks `**`. Used where a most-specific match
 * should win rather than whichever was registered first — which would make behaviour depend on
 * module import order.
 */
export function patternSpecificity(pattern: string): number {
  if (pattern === '*' || pattern === '**') return 0;

  return pattern
    .split('.')
    .reduce((score, segment) => score + (segment === '**' ? 0 : segment === '*' ? 1 : 10), 0);
}

/** The patterns that match, most specific first. */
export function rankMatching(name: string, patterns: readonly string[]): string[] {
  return patterns
    .filter((pattern) => matchesPattern(name, pattern))
    .sort((a, b) => patternSpecificity(b) - patternSpecificity(a) || a.localeCompare(b));
}
