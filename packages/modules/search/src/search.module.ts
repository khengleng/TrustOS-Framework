import { moduleDeclarations } from '@trustos/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustos/module-sdk';
import { searchConfigSchema, type SearchConfig } from './config';
import type { Ranker } from './ranking';
import { SearchService } from './search.service';

export interface SearchInstance extends ModuleInstance {
  readonly service: SearchService;
}

export interface SearchOverrides {
  ranker?: Ranker;
}

export function createSearch(
  context: ModuleContext<SearchConfig>,
  overrides: SearchOverrides = {},
): SearchInstance {
  const service = new SearchService(context, overrides.ranker);

  return {
    moduleId: 'search',
    service,

    async initialize(): Promise<void> {
      // The only module with no tables of its own, so no database is required:
      // it queries what other modules already store. An index would be a second
      // copy of customer data to keep tenant-correct.
      context.logger.info(
        { moduleId: 'search', sources: service.sources(['*']).length },
        'search module initialized',
      );
    },

    async shutdown(): Promise<void> {
      // Nothing to release.
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('search', async () => {
        const registered = service.sources(['*']);

        // No sources is not a failure — an application may register them later —
        // but it is worth surfacing, because a search box that returns nothing
        // looks identical to one that is wired wrongly.
        return registered.length === 0
          ? { status: 'degraded', detail: 'no searchable sources registered' }
          : { status: 'ok', detail: `${registered.length} source(s)` };
      });
    },
  };
}

export const searchModule = defineModule<SearchConfig>({
  ...moduleDeclarations('search'),
  configSchema: searchConfigSchema,
  tenantScoped: true,
  create: (context) => createSearch(context),
});
