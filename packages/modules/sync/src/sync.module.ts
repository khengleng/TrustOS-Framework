import { z } from 'zod';
import { moduleDeclarations } from '@trustos/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustos/module-sdk';

/**
 * The synchronization module.
 *
 * Pull, push and bidirectional synchronization with incremental watermarks and conflict policies.
 *
 * A thin wrapper. The implementation is in `@trustos/sync` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * The watermark is always the remote’s own value, and it advances only after a batch is
 * processed. Both rules are silent when broken — see the header of `sync.ts`.
 */

export const syncConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type SyncConfig = z.infer<typeof syncConfigSchema>;

export interface SyncInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createSync(context: ModuleContext<SyncConfig>): SyncInstance {
  let ready = false;

  return {
    moduleId: 'sync',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'sync', enabled: ready },
        ready ? 'sync module initialized' : 'sync module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('sync', async () =>
        ready
          ? { status: 'ok', detail: 'No sync connection is paused or accumulating conflicts.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const syncModule = defineModule<SyncConfig>({
  ...moduleDeclarations('sync'),
  configSchema: syncConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createSync,
});
