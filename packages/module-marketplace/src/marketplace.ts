import { ApiError } from '@trustsystem/errors';
import {
  averageRating,
  qualityScore,
  securityScore,
  type ModuleCatalogEntry,
  type ModuleProvenance,
} from '@trustsystem/module-registry';
import { compareVersions, satisfies } from '@trustsystem/version-manager';

/**
 * The marketplace.
 *
 * **There is no remote registry, and that is the design.** The catalogue is local and
 * version-controlled, exactly as the template registry is. The generator can only ever write
 * files that have been through review in this repository, and the marketplace can only ever
 * install modules that have. Every property that makes the supply chain tractable comes from
 * that: no dependency confusion, no typosquatting, no compromised mirror, no install-time
 * network.
 *
 * The word "marketplace" usually implies the opposite, so it is worth saying what this actually
 * is: **a browsable, searchable, signed index of what the platform ships**, plus the machinery a
 * deployment needs to run its own private index against its own trust store. Adding a source is a
 * deliberate act with a key attached, not a URL in a config file.
 *
 * What it does not do: fetch, publish, take payment, or rank by popularity. Ranking by downloads
 * is how the most-installed module becomes the most-installed module.
 */

export interface MarketplaceEntry {
  catalog: ModuleCatalogEntry;
  provenance: ModuleProvenance;
}

export interface SearchQuery {
  /** Free text over id, name, description and tags. */
  text?: string;
  tags?: readonly string[];
  /** Only modules compatible with this framework version. */
  frameworkVersion?: string;
  /** Minimum security score. Modules with no score are excluded when this is set. */
  minSecurityScore?: number;
  /** Include modules that are deprecated or withdrawn. Off by default. */
  includeRetired?: boolean;
  /** Only signed modules. The right default for a production deployment. */
  signedOnly?: boolean;
}

export type SortOrder = 'relevance' | 'name' | 'security' | 'quality' | 'rating';

export class Marketplace {
  private readonly entries: MarketplaceEntry[];

  constructor(entries: readonly MarketplaceEntry[]) {
    this.entries = [...entries];
  }

  all(): readonly MarketplaceEntry[] {
    return this.entries;
  }

  find(moduleId: string): MarketplaceEntry | null {
    return this.entries.find((entry) => entry.catalog.metadata.id === moduleId) ?? null;
  }

  require(moduleId: string): MarketplaceEntry {
    const entry = this.find(moduleId);

    if (!entry) {
      throw ApiError.notFound(
        `No module "${moduleId}" in the catalogue. Available: ` +
          `${this.entries.map((candidate) => candidate.catalog.metadata.id).join(', ')}.`,
      );
    }

    return entry;
  }

  /** Every distinct tag, for a category listing. */
  categories(): Array<{ tag: string; count: number }> {
    const counts = new Map<string, number>();

    for (const entry of this.entries) {
      for (const tag of entry.catalog.metadata.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
  }

  search(query: SearchQuery = {}, order: SortOrder = 'relevance'): MarketplaceEntry[] {
    const text = query.text?.trim().toLowerCase() ?? '';
    const terms = text.split(/\s+/).filter((term) => term.length >= 2);

    const scored = this.entries
      /*
       * Deprecated *and* withdrawn are hidden unless asked for. Reusing `isInstallable` here
       * would conflate two different questions — "may this be installed" and "should somebody
       * browsing for a module see it" — and a deprecated module in a search result is one
       * somebody picks for a new project.
       */
      .filter(
        (entry) =>
          query.includeRetired ||
          (entry.provenance.status !== 'withdrawn' && entry.provenance.status !== 'deprecated'),
      )
      .filter((entry) => !query.signedOnly || entry.provenance.signedBy !== null)
      .filter((entry) => {
        if (!query.frameworkVersion) return true;
        return (
          compareVersions(query.frameworkVersion, entry.catalog.metadata.minimumFrameworkVersion) >=
          0
        );
      })
      .filter((entry) => {
        if (query.minSecurityScore === undefined) return true;
        const score = securityScore(entry.provenance);
        // An unscored module is excluded rather than treated as zero *or* as passing: the
        // caller asked for evidence, and there is none either way.
        return score !== null && score >= query.minSecurityScore;
      })
      .filter((entry) => {
        if (!query.tags || query.tags.length === 0) return true;
        return query.tags.every((tag) => entry.catalog.metadata.tags.includes(tag));
      })
      .map((entry) => ({ entry, relevance: relevanceOf(entry, terms) }))
      .filter((result) => terms.length === 0 || result.relevance > 0);

    return sortResults(scored, order).map((result) => result.entry);
  }

  /**
   * Whether a module can be installed here, and why not.
   *
   * Returns reasons rather than throwing, because an installer wants to show all of them at once.
   * A user told "not compatible", who fixes that and is then told "unsigned", learns to expect a
   * queue of refusals.
   */
  canInstall(
    moduleId: string,
    options: { frameworkVersion: string; requireSigned?: boolean },
  ): { allowed: boolean; reasons: string[] } {
    const entry = this.require(moduleId);
    const reasons: string[] = [];

    if (!isInstallableStatus(entry.provenance.status)) {
      reasons.push(
        `"${moduleId}" has been withdrawn. Use "${entry.provenance.supersededBy}" instead — a ` +
          'module is usually withdrawn because of a vulnerability.',
      );
    }

    if (
      compareVersions(options.frameworkVersion, entry.catalog.metadata.minimumFrameworkVersion) < 0
    ) {
      reasons.push(
        `"${moduleId}" needs framework ${entry.catalog.metadata.minimumFrameworkVersion} or newer; ` +
          `this is ${options.frameworkVersion}.`,
      );
    }

    if (options.requireSigned && entry.provenance.signedBy === null) {
      reasons.push(`"${moduleId}" is unsigned and this deployment requires signed modules.`);
    }

    if (entry.provenance.status === 'deprecated') {
      // Not a reason to refuse — something already depends on it, and blocking the install turns
      // an upgrade into a rewrite. Worth saying out loud, though.
      reasons.push(
        `Note: "${moduleId}" is deprecated in favour of "${entry.provenance.supersededBy}". It ` +
          'still installs.',
      );
    }

    const blocking = reasons.filter((reason) => !reason.startsWith('Note:'));

    return { allowed: blocking.length === 0, reasons };
  }

  /** The dependency ids a module pulls in, transitively. */
  dependenciesOf(moduleId: string): string[] {
    const found = new Set<string>();
    const queue = [moduleId];

    while (queue.length > 0) {
      const current = queue.pop() as string;
      const entry = this.find(current);

      for (const dependency of entry?.catalog.dependencies ?? []) {
        if (found.has(dependency.moduleId)) continue;
        found.add(dependency.moduleId);
        queue.push(dependency.moduleId);
      }
    }

    return [...found].sort();
  }

  /** Modules that would break if this one were removed. */
  dependantsOf(moduleId: string): string[] {
    return this.entries
      .filter((entry) =>
        entry.catalog.dependencies.some(
          (dependency) => dependency.moduleId === moduleId && !dependency.optional,
        ),
      )
      .map((entry) => entry.catalog.metadata.id)
      .sort();
  }

  /**
   * Records a rating.
   *
   * Ratings never affect the security or quality score, and never affect whether a module can be
   * installed. Mixing "eleven people liked it" with "it passed the security gates" produces a
   * number that means neither.
   */
  rate(moduleId: string, rating: number): ModuleProvenance {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw ApiError.validation(
        [
          {
            path: 'rating',
            message: 'A rating is a whole number from 1 to 5.',
            code: 'invalid_rating',
          },
        ],
        'Invalid rating.',
      );
    }

    const entry = this.require(moduleId);
    entry.provenance.ratings.push(rating);
    return entry.provenance;
  }
}

/** Withdrawn is the only status that blocks an install. See `canInstall`. */
const isInstallableStatus = (status: string): boolean => status !== 'withdrawn';

function relevanceOf(entry: MarketplaceEntry, terms: readonly string[]): number {
  if (terms.length === 0) return 1;

  const { id, name, description, tags } = entry.catalog.metadata;
  let score = 0;

  for (const term of terms) {
    // Weighted by where the match is. An id match is a near-certain intent; a description match
    // is a maybe.
    if (id.toLowerCase().includes(term)) score += 8;
    if (name.toLowerCase().includes(term)) score += 4;
    if (tags.some((tag) => tag.toLowerCase().includes(term))) score += 3;
    if (description.toLowerCase().includes(term)) score += 1;
  }

  return score;
}

function sortResults(
  results: Array<{ entry: MarketplaceEntry; relevance: number }>,
  order: SortOrder,
): Array<{ entry: MarketplaceEntry; relevance: number }> {
  const byName = (a: MarketplaceEntry, b: MarketplaceEntry) =>
    a.catalog.metadata.id < b.catalog.metadata.id ? -1 : 1;

  switch (order) {
    case 'name':
      return [...results].sort((a, b) => byName(a.entry, b.entry));

    case 'security':
      return [...results].sort(
        (a, b) =>
          (securityScore(b.entry.provenance) ?? -1) - (securityScore(a.entry.provenance) ?? -1) ||
          byName(a.entry, b.entry),
      );

    case 'quality':
      return [...results].sort(
        (a, b) =>
          (qualityScore(b.entry.provenance) ?? -1) - (qualityScore(a.entry.provenance) ?? -1) ||
          byName(a.entry, b.entry),
      );

    case 'rating':
      return [...results].sort(
        (a, b) =>
          (averageRating(b.entry.provenance) ?? -1) - (averageRating(a.entry.provenance) ?? -1) ||
          byName(a.entry, b.entry),
      );

    case 'relevance':
      return [...results].sort((a, b) => b.relevance - a.relevance || byName(a.entry, b.entry));
  }
}

/** A one-line summary for a listing. */
export function summarize(entry: MarketplaceEntry): string {
  const security = securityScore(entry.provenance);
  const quality = qualityScore(entry.provenance);
  const rating = averageRating(entry.provenance);

  const parts = [
    `security ${security ?? '—'}`,
    `quality ${quality ?? '—'}`,
    rating === null ? 'unrated' : `${rating}/5 from ${entry.provenance.ratings.length}`,
    entry.provenance.signedBy ? `signed by ${entry.provenance.signedBy}` : 'unsigned',
  ];

  return parts.join(' · ');
}

export { satisfies };
