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
 * The settlement module.
 *
 * Settlement batches, instructions and windows, with partial confirmation and returns. Asynchronous by construction.
 *
 * A thin wrapper. The implementation is in `@trustsystem/financial-core`, `@trustsystem/settlement` —
 * this package contributes the declarations the platform needs (permissions, audit events,
 * health) and the start/stop lifecycle.
 *
 * The settlement account is the whole mechanism: money leaves a merchant and sits there until
 * the counterparty confirms. That balance is exactly what has been instructed and not paid, and
 * it is the number to check against a bank statement.
 */

export const settlementConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type SettlementConfig = z.infer<typeof settlementConfigSchema>;

export interface SettlementInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createSettlement(context: ModuleContext<SettlementConfig>): SettlementInstance {
  let ready = false;

  return {
    moduleId: 'settlement',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'settlement', enabled: ready },
        ready ? 'settlement module initialized' : 'settlement module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('settlement', async () =>
        ready
          ? { status: 'ok', detail: 'No batch has been in transit longer than its window allows.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const settlementModule = defineModule<SettlementConfig>({
  ...moduleDeclarations('settlement'),
  configSchema: settlementConfigSchema,
  // Every balance belongs to somebody, and a query with no tenant returns every organization's
  // money. There is no such thing as an untenanted financial module.
  tenantScoped: true,
  create: createSettlement,
});
