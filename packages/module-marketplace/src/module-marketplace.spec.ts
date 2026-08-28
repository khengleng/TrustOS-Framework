import { describe, expect, it } from 'vitest';
import {
  moduleProvenanceSchema,
  averageRating,
  securityScore,
  scoreOf,
} from '@trustos/module-registry';
import { Marketplace, summarize, type MarketplaceEntry } from './index';

/**
 * The marketplace is a local, signed index. The tests are about what it refuses and how it ranks —
 * the two places a marketplace becomes a supply-chain problem.
 */

const entry = (
  id: string,
  overrides: { catalog?: Record<string, unknown>; provenance?: Record<string, unknown> } = {},
): MarketplaceEntry =>
  ({
    catalog: {
      metadata: {
        id,
        name: id,
        description: `The ${id} module.`,
        version: '1.0.0',
        minimumFrameworkVersion: '0.4.0',
        owner: 'Team',
        stability: 'stable',
        tags: ['core'],
        ...overrides.catalog,
      },
      dependencies: [],
    },
    provenance: moduleProvenanceSchema.parse({
      moduleId: id,
      author: 'Team',
      license: 'UNLICENSED',
      status: 'stable',
      signedBy: 'release',
      ...overrides.provenance,
    }),
  }) as MarketplaceEntry;

describe('scores', () => {
  it('returns null when nothing has been checked, never zero', () => {
    /*
     * Zero says "it failed everything"; null says "nobody looked", and those lead to opposite
     * decisions.
     */
    expect(scoreOf([])).toBeNull();
  });

  it('weights the checks it was given', () => {
    expect(
      scoreOf([
        { check: 'a', passed: true, weight: 3, detail: '' },
        { check: 'b', passed: false, weight: 1, detail: '' },
      ]),
    ).toBe(75);
  });

  it('keeps ratings out of the score', () => {
    // Mixing "eleven people liked it" with "it passed the security gates" produces a number that
    // means neither.
    const provenance = moduleProvenanceSchema.parse({
      moduleId: 'search',
      author: 'Team',
      license: 'MIT',
      ratings: [5, 5, 5],
      securityChecks: [{ check: 'a', passed: false, weight: 1, detail: '' }],
    });

    expect(averageRating(provenance)).toBe(5);
    expect(securityScore(provenance)).toBe(0);
  });

  it('refuses a deprecated module with nowhere to go', () => {
    expect(() =>
      moduleProvenanceSchema.parse({
        moduleId: 'old',
        author: 'Team',
        license: 'MIT',
        status: 'deprecated',
      }),
    ).toThrow();
  });
});

describe('search', () => {
  const marketplace = new Marketplace([
    entry('search', { catalog: { tags: ['discovery', 'core'] } }),
    entry('notification', {
      catalog: { tags: ['messaging'], description: 'Sends a search digest.' },
    }),
    entry('old-thing', {
      provenance: { status: 'deprecated', supersededBy: 'search' },
    }),
    entry('unsafe', { provenance: { status: 'withdrawn', supersededBy: 'search' } }),
    entry('unsigned-one', { provenance: { signedBy: null } }),
  ]);

  it('hides retired modules by default', () => {
    const ids = marketplace.search().map((result) => result.catalog.metadata.id);

    expect(ids).not.toContain('old-thing');
    expect(ids).not.toContain('unsafe');
  });

  it('ranks an id match above a description match', () => {
    // An id match is a near-certain intent; a description match is a maybe.
    const results = marketplace.search({ text: 'search' });

    expect(results[0]?.catalog.metadata.id).toBe('search');
  });

  it('filters to signed modules when asked', () => {
    const ids = marketplace
      .search({ signedOnly: true })
      .map((result) => result.catalog.metadata.id);

    expect(ids).not.toContain('unsigned-one');
  });

  it('excludes an unscored module when a minimum score is set', () => {
    // The caller asked for evidence, and there is none either way.
    expect(marketplace.search({ minSecurityScore: 50 })).toEqual([]);
  });

  it('filters by framework version', () => {
    const marketplace = new Marketplace([
      entry('newer', { catalog: { minimumFrameworkVersion: '0.9.0' } }),
      entry('older', { catalog: { minimumFrameworkVersion: '0.1.0' } }),
    ]);

    expect(
      marketplace.search({ frameworkVersion: '0.5.0' }).map((result) => result.catalog.metadata.id),
    ).toEqual(['older']);
  });

  it('counts categories', () => {
    expect(marketplace.categories().find((category) => category.tag === 'core')?.count).toBe(4);
  });
});

describe('installability', () => {
  const marketplace = new Marketplace([
    entry('search'),
    entry('unsafe', { provenance: { status: 'withdrawn', supersededBy: 'search' } }),
    entry('old-thing', { provenance: { status: 'deprecated', supersededBy: 'search' } }),
    entry('unsigned-one', { provenance: { signedBy: null } }),
    entry('newer', { catalog: { minimumFrameworkVersion: '0.9.0' } }),
  ]);

  it('refuses a withdrawn module', () => {
    const verdict = marketplace.canInstall('unsafe', { frameworkVersion: '0.5.0' });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons[0]).toMatch(/usually withdrawn because of a vulnerability/);
  });

  it('allows a deprecated module while saying so', () => {
    // Something already depends on it, and blocking the install turns an upgrade into a rewrite.
    const verdict = marketplace.canInstall('old-thing', { frameworkVersion: '0.5.0' });

    expect(verdict.allowed).toBe(true);
    expect(verdict.reasons[0]).toMatch(/^Note: /);
  });

  it('reports every reason at once', () => {
    /*
     * A user told "not compatible", who fixes that and is then told "unsigned", learns to expect
     * a queue of refusals.
     */
    const marketplace = new Marketplace([
      entry('bad', {
        catalog: { minimumFrameworkVersion: '0.9.0' },
        provenance: { signedBy: null },
      }),
    ]);

    const verdict = marketplace.canInstall('bad', {
      frameworkVersion: '0.5.0',
      requireSigned: true,
    });

    expect(verdict.reasons).toHaveLength(2);
  });

  it('names the alternatives when the id is wrong', () => {
    expect(() => marketplace.require('serch')).toThrow(/Available: /);
  });
});

describe('dependencies', () => {
  const marketplace = new Marketplace([
    entry('reporting', {
      catalog: {},
    }),
    entry('search'),
  ]);

  it('finds what depends on a module', () => {
    const withDeps = new Marketplace([
      {
        ...entry('reporting'),
        catalog: {
          ...entry('reporting').catalog,
          dependencies: [
            { moduleId: 'search', versionRange: '^1.0.0', optional: false, reason: 'x' },
          ],
        },
      } as MarketplaceEntry,
      entry('search'),
    ]);

    expect(withDeps.dependantsOf('search')).toEqual(['reporting']);
    expect(withDeps.dependenciesOf('reporting')).toEqual(['search']);
  });

  it('reports nothing for a module with no edges', () => {
    expect(marketplace.dependantsOf('search')).toEqual([]);
  });
});

describe('ratings', () => {
  it('accepts a whole number from 1 to 5', () => {
    const marketplace = new Marketplace([entry('search')]);

    expect(averageRating(marketplace.rate('search', 4))).toBe(4);
    expect(() => marketplace.rate('search', 6)).toThrow();
    expect(() => marketplace.rate('search', 3.5)).toThrow();
  });
});

describe('summaries', () => {
  it('says when something is unscored or unsigned rather than implying a value', () => {
    expect(summarize(entry('search', { provenance: { signedBy: null } }))).toBe(
      'security — · quality — · unrated · unsigned',
    );
  });
});
