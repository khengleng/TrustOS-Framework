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
 * The import module.
 *
 * Bulk import with CSV and JSON parsing, per-row validation, preview, dry run, apply and rollback.
 *
 * A thin wrapper. The implementation is in `@trustsystem/import` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * Validation runs over every row before anything is written. An import that wrote 4,000 rows
 * and then failed leaves a state nobody can describe afterwards.
 */

export const importConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ImportConfig = z.infer<typeof importConfigSchema>;

export interface ImportInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createImport(context: ModuleContext<ImportConfig>): ImportInstance {
  let ready = false;

  return {
    moduleId: 'import',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'import', enabled: ready },
        ready ? 'import module initialized' : 'import module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('import', async () =>
        ready
          ? { status: 'ok', detail: 'The import handlers are registered.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const importModule = defineModule<ImportConfig>({
  ...moduleDeclarations('import'),
  configSchema: importConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createImport,
});
