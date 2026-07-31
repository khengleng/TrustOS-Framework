import { describe, expect, it } from 'vitest';
import {
  areComparable,
  cosineSimilarity,
  dotProduct,
  euclideanDistance,
  explainIncomparable,
  score,
} from './index';

/**
 * Embedding comparison.
 *
 * The failure this exists to prevent is the quiet one: comparing two vectors from *different
 * models*. The arithmetic succeeds, a number comes out, and the number is meaningless — so a
 * search returns confident, wrong results and nothing anywhere errors.
 *
 * The tests are therefore mostly about refusal: when the vectors are not comparable, and when the
 * dimensions do not match.
 */

const a = [1, 0, 0];
const b = [0, 1, 0];

describe('comparability', () => {
  const model = { modelId: 'text-embedding-3-small', dimensions: 1536, version: '1' };

  it('accepts two vectors from the same model, dimensions and version', () => {
    expect(areComparable(model, { ...model })).toBe(true);
    expect(explainIncomparable(model, { ...model })).toBeNull();
  });

  it('refuses two vectors from different models', () => {
    /*
     * The whole point. Two models embed the same text into different spaces; a cosine between
     * them is a number with no meaning, and it will sit in the middle of the score range where
     * nobody notices it.
     */
    const other = { ...model, modelId: 'text-embedding-3-large' };

    expect(areComparable(model, other)).toBe(false);
    expect(explainIncomparable(model, other)).toMatch(/text-embedding-3-large|model/i);
  });

  it('refuses two vectors of different dimensions', () => {
    const other = { ...model, dimensions: 768 };

    expect(areComparable(model, other)).toBe(false);
    expect(explainIncomparable(model, other)).toMatch(/768|1536|dimension/i);
  });

  it('refuses two vectors from different versions of the same model', () => {
    // A provider can change a model's output without changing its name. The version is what
    // catches that, and it is the case people forget exists.
    const other = { ...model, version: '2' };

    expect(areComparable(model, other)).toBe(false);
    expect(explainIncomparable(model, other)).not.toBeNull();
  });
});

describe('distance metrics', () => {
  it('scores identical vectors as maximally similar under cosine', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('scores orthogonal vectors as zero under cosine', () => {
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('scores opposite vectors as -1 under cosine', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('is unaffected by magnitude, which is what makes it cosine', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('computes euclidean distance', () => {
    expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5, 10);
    expect(euclideanDistance([1, 1], [1, 1])).toBeCloseTo(0, 10);
  });

  it('computes a dot product', () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(dotProduct(a, b)).toBe(0);
  });

  it('dispatches on the named metric', () => {
    expect(score([1, 2, 3], [1, 2, 3], 'cosine')).toBeCloseTo(1, 10);
    // Euclidean is a *distance*, so score inverts it: higher is better under every metric, which
    // is what lets them be mixed in one ranking without silently reversing the order.
    expect(score([0, 0], [3, 4], 'euclidean')).toBeCloseTo(1 / 6, 10);
    expect(score([1, 2, 3], [4, 5, 6], 'dot_product')).toBe(32);
  });

  it('refuses vectors of different lengths rather than producing a number', () => {
    /*
     * Every one of these would otherwise return *something* — a partial sum over the shorter
     * vector — and a plausible number from mismatched inputs is worse than an exception.
     */
    for (const metric of ['cosine', 'euclidean', 'dot_product'] as const) {
      expect(() => score([1, 2, 3], [1, 2], metric)).toThrow(/dimension/i);
    }
  });

  it('does not divide by zero on a zero vector', () => {
    // A zero vector has no direction, so cosine is undefined. Returning NaN would propagate into
    // a ranking and sort unpredictably.
    const result = cosineSimilarity([0, 0, 0], [1, 2, 3]);

    expect(Number.isFinite(result)).toBe(true);
  });
});
