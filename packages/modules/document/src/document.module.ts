import { moduleDeclarations } from '@trustos/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustos/module-sdk';
import { LocalStorageProvider, type StorageProvider } from '@trustos/module-file-storage';
import { documentConfigSchema, type DocumentConfig } from './config';
import { DocumentService } from './document.service';
import { PrismaDocumentStore, type DocumentStore } from './store';

export interface DocumentInstance extends ModuleInstance {
  readonly service: DocumentService;
}

export interface DocumentOverrides {
  store?: DocumentStore;
  storage?: StorageProvider;
}

export function createDocument(
  context: ModuleContext<DocumentConfig>,
  overrides: DocumentOverrides = {},
): DocumentInstance {
  // The provider comes from the file-storage module. An application that has
  // moved file storage to a bucket passes that provider here and document content
  // follows it without a change in this module.
  const storage = overrides.storage ?? new LocalStorageProvider(context.config.storageRoot);
  const store = overrides.store ?? new PrismaDocumentStore(context);
  const service = new DocumentService(context, store, storage);

  return {
    moduleId: 'document',
    service,

    async initialize(): Promise<void> {
      if (!context.prisma && !overrides.store) {
        throw new Error(
          'document needs a database. Run the module migration and provide the Prisma client.',
        );
      }

      const health = await storage.check();
      context.logger.info(
        { moduleId: 'document', provider: storage.id, detail: health.detail },
        'document module initialized',
      );
    },

    async shutdown(): Promise<void> {
      // Nothing to release.
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('document', async () => {
        const result = await storage.check();
        return result.ok
          ? { status: 'ok', detail: `${storage.id}: ${result.detail}` }
          : { status: 'down', detail: `${storage.id}: ${result.detail}` };
      });
    },
  };
}

export const documentModule = defineModule<DocumentConfig>({
  ...moduleDeclarations('document'),
  configSchema: documentConfigSchema,
  tenantScoped: true,
  create: (context) => createDocument(context),
});
