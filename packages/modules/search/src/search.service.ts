import { ApiError } from '@trustsystem/errors';
import type { ModuleContext } from '@trustsystem/module-sdk';
import { buildPageMeta, type Paginated } from '@trustsystem/shared-types';
import { searchTermSchema, type SearchAdapter, type SearchHit } from './adapter';
import type { SearchConfig } from './config';
import { sourceOrderRanker, weightedRanker, type Ranker } from './ranking';

/**
 * Global search for one application.
 *
 * The service does four things, in this order, and the order is the design:
 *
 *   1. **Filter sources by permission.** An adapter the caller cannot read is
 *      never queried, so a hit they should not see is never produced — rather
 *      than produced and then filtered, which is one refactor away from leaking.
 *   2. **Fan out with a per-source ceiling.** Every adapter runs concurrently
 *      and bounded, so one slow or large source cannot dominate the request.
 *   3. **Verify the tenant on every hit.** An adapter returning a foreign row is
 *      a bug in that adapter; the hit is dropped, audited and counted rather than
 *      trusted.
 *   4. **Rank, then paginate.** In that order — paginating before ranking would
 *      return the most relevant results on an arbitrary page.
 */

export interface SearchQuery {
  term: string;
  /** Restrict to named sources. Unknown ids are rejected, not ignored. */
  sources?: string[];
  page?: number;
  pageSize?: number;
}

export interface SearchSourceSummary {
  id: string;
  label: string;
  permission: string;
}

export class SearchService {
  private readonly adapters = new Map<string, SearchAdapter>();

  constructor(
    private readonly context: ModuleContext<SearchConfig>,
    private readonly ranker?: Ranker,
  ) {}

  /**
   * Registers a searchable source.
   *
   * Registering twice is refused: two adapters sharing an id would make the
   * source a result came from ambiguous, and the source is what a caller uses to
   * decide whether they are allowed to follow the link.
   */
  register(adapter: SearchAdapter): this {
    if (this.adapters.has(adapter.id)) {
      throw ApiError.internal(`A search adapter with id "${adapter.id}" is already registered.`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  /** Sources the caller may search. */
  sources(permissions: string[]): SearchSourceSummary[] {
    return this.visibleAdapters(permissions)
      .map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        permission: adapter.permission,
      }))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
  }

  async search(
    query: SearchQuery,
    organizationId: string,
    permissions: string[],
  ): Promise<Paginated<SearchHit>> {
    const config = await this.context.resolveConfig(organizationId);
    const term = searchTermSchema.parse(query.term);

    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(config.maxPageSize, Math.max(1, Math.floor(query.pageSize ?? 20)));

    const adapters = this.selectAdapters(query.sources, permissions);

    // `allSettled`, not `all`: one adapter throwing must not take down a search
    // across five sources. The failure is logged and the source is absent, which
    // is visible to the caller as a smaller result set.
    const settled = await Promise.allSettled(
      adapters.map((adapter) =>
        adapter.search({ term, organizationId, limit: config.maxResultsPerSource }),
      ),
    );

    const hits: SearchHit[] = [];
    let dropped = 0;

    settled.forEach((result, index) => {
      const adapter = adapters[index];
      if (!adapter) return;

      if (result.status === 'rejected') {
        this.context.logger.error(
          {
            moduleId: this.context.moduleId,
            source: adapter.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
          'search adapter failed',
        );
        return;
      }

      for (const hit of result.value) {
        if (hit.organizationId !== organizationId) {
          dropped += 1;
          continue;
        }
        hits.push({ ...hit, source: adapter.id });
      }
    });

    if (dropped > 0) {
      // Recorded rather than silently discarded: an adapter returning another
      // organization's rows is a defect that has to surface somewhere, and the
      // audit trail is read.
      await this.context.audit.record({
        action: 'search.result.dropped',
        entityType: 'SearchQuery',
        organizationId,
        after: { dropped, sources: adapters.map((adapter) => adapter.id) },
      });

      this.context.logger.error(
        { moduleId: this.context.moduleId, dropped, organizationId },
        'search adapter returned rows from another organization',
      );
    }

    const ranked = this.rankerFor(config).rank(hits, term);
    const items = ranked.slice((page - 1) * pageSize, page * pageSize);

    await this.context.audit.record({
      action: 'search.query.executed',
      entityType: 'SearchQuery',
      organizationId,
      after: {
        // The term, when the organization has not opted out. The results are
        // never recorded: a trail of what someone found is a second copy of the
        // data with different access controls.
        ...(config.auditSearchTerms ? { term } : {}),
        sources: adapters.map((adapter) => adapter.id),
        results: ranked.length,
      },
    });

    return { items, meta: buildPageMeta({ page, pageSize }, ranked.length) };
  }

  // --- internals ------------------------------------------------------------

  private rankerFor(config: SearchConfig): Ranker {
    if (this.ranker) return this.ranker;
    return config.weightedRanking ? weightedRanker : sourceOrderRanker;
  }

  private visibleAdapters(permissions: string[]): SearchAdapter[] {
    const held = new Set(permissions);
    const all = held.has('*');

    return [...this.adapters.values()].filter((adapter) => all || held.has(adapter.permission));
  }

  private selectAdapters(requested: string[] | undefined, permissions: string[]): SearchAdapter[] {
    const visible = this.visibleAdapters(permissions);
    if (!requested || requested.length === 0) return visible;

    const byId = new Map(visible.map((adapter) => [adapter.id, adapter]));
    const selected: SearchAdapter[] = [];

    for (const id of requested) {
      const adapter = byId.get(id);
      // A source the caller cannot read and a source that does not exist are the
      // same answer, so asking for one is not a way to discover the other.
      if (!adapter) throw ApiError.notFound(`No searchable source "${id}".`);
      selected.push(adapter);
    }

    return selected;
  }
}
