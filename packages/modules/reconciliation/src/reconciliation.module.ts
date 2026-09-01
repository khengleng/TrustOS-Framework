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
 * The reconciliation module.
 *
 * Internal and external reconciliation with tolerance rules, an exception queue and resolution history.
 *
 * A thin wrapper. The implementation is in `@trustsystem/financial-core`, `@trustsystem/reconciliation` —
 * this package contributes the declarations the platform needs (permissions, audit events,
 * health) and the start/stop lifecycle.
 *
 * The output is a queue, not a number. "£3.42 out" is not actionable; "these four are on the
 * statement and not in the ledger" is. Matching is by reference first, because amount-only
 * matching pairs two unrelated payments and reports a clean run.
 */

export const reconciliationConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type ReconciliationConfig = z.infer<typeof reconciliationConfigSchema>;

export interface ReconciliationInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createReconciliation(
  context: ModuleContext<ReconciliationConfig>,
): ReconciliationInstance {
  let ready = false;

  return {
    moduleId: 'reconciliation',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'reconciliation', enabled: ready },
        ready
          ? 'reconciliation module initialized'
          : 'reconciliation module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('reconciliation', async () =>
        ready
          ? {
              status: 'ok',
              detail: 'The exception queue is being worked and nothing has been open too long.',
            }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const reconciliationModule = defineModule<ReconciliationConfig>({
  ...moduleDeclarations('reconciliation'),
  configSchema: reconciliationConfigSchema,
  // Every balance belongs to somebody, and a query with no tenant returns every organization's
  // money. There is no such thing as an untenanted financial module.
  tenantScoped: true,
  create: createReconciliation,
});
