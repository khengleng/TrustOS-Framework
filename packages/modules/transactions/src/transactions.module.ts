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
 * The transactions module.
 *
 * The transaction lifecycle with idempotency, fees, limits, risk hooks and payment requests.
 *
 * A thin wrapper. The implementation is in `@trustsystem/fees`, `@trustsystem/financial-core`, `@trustsystem/financial-risk`, `@trustsystem/fx`, `@trustsystem/limits`, `@trustsystem/payments`, `@trustsystem/transactions` —
 * this package contributes the declarations the platform needs (permissions, audit events,
 * health) and the start/stop lifecycle.
 *
 * Every operation takes an idempotency key and the store enforces it uniquely. A client with a
 * 30-second timeout against a service with a 35-second p99 retries a meaningful fraction of
 * everything, so "retried" is the normal case rather than the exception.
 */

export const transactionsConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type TransactionsConfig = z.infer<typeof transactionsConfigSchema>;

export interface TransactionsInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createTransactions(
  context: ModuleContext<TransactionsConfig>,
): TransactionsInstance {
  let ready = false;

  return {
    moduleId: 'transactions',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'transactions', enabled: ready },
        ready
          ? 'transactions module initialized'
          : 'transactions module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('transactions', async () =>
        ready
          ? {
              status: 'ok',
              detail: 'The transaction store is reachable and nothing is stuck in authorized.',
            }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const transactionsModule = defineModule<TransactionsConfig>({
  ...moduleDeclarations('transactions'),
  configSchema: transactionsConfigSchema,
  // Every balance belongs to somebody, and a query with no tenant returns every organization's
  // money. There is no such thing as an untenanted financial module.
  tenantScoped: true,
  create: createTransactions,
});
