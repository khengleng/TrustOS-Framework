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
 * The wallets module.
 *
 * Ledger-backed customer wallets: available, held and reserved balances, holds, freeze and history.
 *
 * A thin wrapper. The implementation is in `@trustos/financial-core`, `@trustos/limits`, `@trustos/wallet` —
 * this package contributes the declarations the platform needs (permissions, audit events,
 * health) and the start/stop lifecycle.
 *
 * A wallet is a view over a ledger account, never a balance of its own. A wallet with its own
 * balance column has two sources of truth, they disagree within a month, and the one everybody
 * reads is the wrong one.
 */

export const walletConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type WalletConfig = z.infer<typeof walletConfigSchema>;

export interface WalletInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createWallet(context: ModuleContext<WalletConfig>): WalletInstance {
  let ready = false;

  return {
    moduleId: 'wallet',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'wallet', enabled: ready },
        ready ? 'wallet module initialized' : 'wallet module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('wallet', async () =>
        ready
          ? {
              status: 'ok',
              detail: 'Wallet balances are readable and no hold has outlived its expiry unswept.',
            }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const walletModule = defineModule<WalletConfig>({
  ...moduleDeclarations('wallet'),
  configSchema: walletConfigSchema,
  // Every balance belongs to somebody, and a query with no tenant returns every organization's
  // money. There is no such thing as an untenanted financial module.
  tenantScoped: true,
  create: createWallet,
});
