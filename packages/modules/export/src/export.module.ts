import { z } from 'zod';
import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';

/**
 * The export module.
 *
 * Streaming export to CSV, JSON and NDJSON with keyset pagination and formula-injection escaping.
 *
 * A thin wrapper. The implementation is in `@trustsystem/export` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * Rows are never all in memory at once, and a cell beginning `=` is neutralised on the way
 * out — an export is the one file guaranteed to be opened in a spreadsheet.
 */

export const exportConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ExportConfig = z.infer<typeof exportConfigSchema>;

export interface ExportInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createExport(context: ModuleContext<ExportConfig>): ExportInstance {
  let ready = false;

  return {
    moduleId: 'export',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'export', enabled: ready },
        ready ? 'export module initialized' : 'export module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('export', async () =>
        ready
          ? { status: 'ok', detail: 'The export sources are registered.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const exportModule = defineModule<ExportConfig>({
  ...moduleDeclarations('export'),
  configSchema: exportConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createExport,
});
