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
 * The retrieval-augmented generation module.
 *
 * Answering from documents: chunking, embedding, a vector-store interface, hybrid search, citation checking and per-collection access control.
 *
 * A thin wrapper. The implementation is in `@trustos/embedding`, `@trustos/knowledge`, `@trustos/rag`, `@trustos/vector-store` — this
 * package contributes the declarations the platform needs (permissions, audit events, health)
 * and the start/stop lifecycle.
 *
 * The vector store is an interface with an in-memory default, and it is meant to be replaced.
 * Nothing above it knows which database is underneath, which is the only reason a deployment can
 * change that decision later.
 */

export const ragConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type RagConfig = z.infer<typeof ragConfigSchema>;

export interface RagInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createRag(context: ModuleContext<RagConfig>): RagInstance {
  let ready = false;

  return {
    moduleId: 'rag',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'rag', enabled: ready },
        ready ? 'rag module initialized' : 'rag module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('rag', async () =>
        ready
          ? {
              status: 'ok',
              detail: 'The vector store is reachable and at least one collection is populated.',
            }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const ragModule = defineModule<RagConfig>({
  ...moduleDeclarations('rag'),
  configSchema: ragConfigSchema,
  // Every AI call is made on behalf of a tenant, and a request with no tenant cannot be policed,
  // budgeted or audited. There is no such thing as an untenanted AI module.
  tenantScoped: true,
  create: createRag,
});
