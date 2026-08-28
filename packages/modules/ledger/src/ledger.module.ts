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
 * The ledger module.
 *
 * Double-entry bookkeeping: journals, accounts, reversal, trial balance and reporting. Posted journals are immutable and every journal must balance.
 *
 * A thin wrapper. The implementation is in `@trustos/accounts`, `@trustos/financial-core`, `@trustos/financial-policy`, `@trustos/financial-reporting`, `@trustos/ledger` —
 * this package contributes the declarations the platform needs (permissions, audit events,
 * health) and the start/stop lifecycle.
 *
 * Three rules are absolute and all three are enforced at the database as well as in the
 * service: a journal must balance, a posted journal is immutable, and a correction is a new
 * journal. Read the phase 8 section of the schema before changing any of them.
 */

export const ledgerConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type LedgerConfig = z.infer<typeof ledgerConfigSchema>;

export interface LedgerInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createLedger(context: ModuleContext<LedgerConfig>): LedgerInstance {
  let ready = false;

  return {
    moduleId: 'ledger',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'ledger', enabled: ready },
        ready ? 'ledger module initialized' : 'ledger module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('ledger', async () =>
        ready
          ? { status: 'ok', detail: 'The ledger is reachable and its trial balance balances.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const ledgerModule = defineModule<LedgerConfig>({
  ...moduleDeclarations('ledger'),
  configSchema: ledgerConfigSchema,
  // Every balance belongs to somebody, and a query with no tenant returns every organization's
  // money. There is no such thing as an untenanted financial module.
  tenantScoped: true,
  create: createLedger,
});
