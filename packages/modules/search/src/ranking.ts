import type { SearchHit } from './adapter';

/**
 * Result ranking.
 *
 * An abstraction rather than a fixed rule, because relevance is a product
 * decision: a payments product ranks an exact reference above a fuzzy merchant
 * name, and a learning product does the opposite. Two rankers ship, and an
 * application can supply its own.
 */

export interface Ranker {
  readonly id: string;
  rank(hits: SearchHit[], term: string): SearchHit[];
}

/**
 * Scores by how the match happened, not by which adapter answered first.
 *
 * The ordering rules, most to least important:
 *
 *   1. an exact match on the title
 *   2. a title that starts with the term
 *   3. the number of fields that matched
 *   4. the adapter's own weight
 *
 * Ties are broken by source id and then by row id, so the order is stable —
 * an unstable ranking makes pagination return the same row on two pages and
 * skip another entirely.
 */
export const weightedRanker: Ranker = {
  id: 'weighted',

  rank(hits: SearchHit[], term: string): SearchHit[] {
    const lowered = term.toLowerCase();

    const score = (hit: SearchHit): number => {
      const title = hit.title.toLowerCase();
      let value = 0;

      if (title === lowered) value += 1000;
      else if (title.startsWith(lowered)) value += 500;
      else if (title.includes(lowered)) value += 200;

      value += Object.keys(hit.matched).length * 10;
      value += Math.round((hit.weight ?? 0) * 100);
      return value;
    };

    return [...hits].sort((left, right) => {
      const difference = score(right) - score(left);
      if (difference !== 0) return difference;
      if (left.source !== right.source) return left.source < right.source ? -1 : 1;
      return left.id < right.id ? -1 : 1;
    });
  },
};

/** Keeps adapter order. Used when a product wants a fixed source priority. */
export const sourceOrderRanker: Ranker = {
  id: 'source-order',
  rank: (hits: SearchHit[]): SearchHit[] => [...hits],
};
