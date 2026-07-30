import {
  EMPTY_TOTALS,
  type CostEntry,
  type CostFilter,
  type CostStore,
  type CostTotals,
} from './cost';

/** An in-memory cost store, for tests and development. */
export class InMemoryCostStore implements CostStore {
  readonly entries: CostEntry[] = [];

  async record(entry: CostEntry): Promise<void> {
    this.entries.push(entry);
  }

  private matching(filter: CostFilter): CostEntry[] {
    return this.entries
      .filter((entry) => entry.organizationId === filter.organizationId)
      .filter((entry) => !filter.from || entry.occurredAt >= filter.from)
      .filter((entry) => !filter.to || entry.occurredAt <= filter.to)
      .filter((entry) => !filter.application || entry.application === filter.application)
      .filter((entry) => !filter.modelId || entry.modelId === filter.modelId)
      .filter((entry) => !filter.agentId || entry.agentId === filter.agentId);
  }

  async totals(filter: CostFilter): Promise<CostTotals> {
    return this.matching(filter).reduce<CostTotals>(
      (totals, entry) => ({
        costCents: totals.costCents + entry.costCents,
        promptTokens: totals.promptTokens + entry.promptTokens,
        completionTokens: totals.completionTokens + entry.completionTokens,
        totalTokens: totals.totalTokens + entry.totalTokens,
        requests: totals.requests + 1,
        // Tracked separately so a report can say how much of itself will not reconcile.
        estimatedCostCents: totals.estimatedCostCents + (entry.estimated ? entry.costCents : 0),
        cachedRequests: totals.cachedRequests + (entry.cached ? 1 : 0),
      }),
      { ...EMPTY_TOTALS },
    );
  }

  async breakdown(
    filter: CostFilter,
    by: 'model' | 'application' | 'agent' | 'day',
  ): Promise<Array<{ key: string; totals: CostTotals }>> {
    const groups = new Map<string, CostEntry[]>();

    for (const entry of this.matching(filter)) {
      const key =
        by === 'model'
          ? entry.modelId
          : by === 'application'
            ? entry.application
            : by === 'agent'
              ? (entry.agentId ?? '(none)')
              : entry.occurredAt.toISOString().slice(0, 10);

      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }

    return [...groups.entries()]
      .map(([key, entries]) => ({
        key,
        totals: entries.reduce<CostTotals>(
          (totals, entry) => ({
            costCents: totals.costCents + entry.costCents,
            promptTokens: totals.promptTokens + entry.promptTokens,
            completionTokens: totals.completionTokens + entry.completionTokens,
            totalTokens: totals.totalTokens + entry.totalTokens,
            requests: totals.requests + 1,
            estimatedCostCents: totals.estimatedCostCents + (entry.estimated ? entry.costCents : 0),
            cachedRequests: totals.cachedRequests + (entry.cached ? 1 : 0),
          }),
          { ...EMPTY_TOTALS },
        ),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const before = this.entries.length;
    const kept = this.entries.filter((entry) => entry.occurredAt >= cutoff);
    this.entries.length = 0;
    this.entries.push(...kept);
    return before - this.entries.length;
  }
}
