import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';
import { fileStorageConfigSchema, type FileStorageConfig } from './config';
import { FileStorageService } from './file-storage.service';
import { LocalStorageProvider, type StorageProvider } from './provider';
import { PrismaStoredObjectStore, type StoredObjectStore } from './store';

/**
 * The file-storage module.
 *
 * Declarations come from `@trustsystem/module-registry` rather than being restated
 * here; see the header of that package for why the catalog owns them.
 */

export interface FileStorageInstance extends ModuleInstance {
  readonly service: FileStorageService;
  readonly provider: StorageProvider;
}

export interface FileStorageOverrides {
  provider?: StorageProvider;
  store?: StoredObjectStore;
}

/**
 * Builds the module.
 *
 * Exported separately from `create` so tests can substitute the provider and the
 * store. A module that can only be constructed the production way is a module
 * whose failure modes are only reachable in production.
 */
export function createFileStorage(
  context: ModuleContext<FileStorageConfig>,
  overrides: FileStorageOverrides = {},
): FileStorageInstance {
  const provider = overrides.provider ?? new LocalStorageProvider(context.config.root);
  const store = overrides.store ?? new PrismaStoredObjectStore(context);
  const service = new FileStorageService(context, provider, store);

  return {
    moduleId: 'file-storage',
    service,
    provider,

    async initialize(): Promise<void> {
      // Rows live in Postgres. Refusing here rather than falling back to memory
      // means an application never reports a successful upload it cannot read
      // back after a restart.
      if (!context.prisma && !overrides.store) {
        throw new Error(
          'file-storage needs a database. Run the module migration and provide the Prisma client.',
        );
      }

      const health = await provider.check();
      context.logger.info(
        { moduleId: 'file-storage', provider: provider.id, detail: health.detail },
        'file-storage module initialized',
      );
    },

    async shutdown(): Promise<void> {
      // Nothing to release: the provider holds no connections and the Prisma
      // client belongs to the host.
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('file-storage', async () => {
        const result = await provider.check();
        return result.ok
          ? { status: 'ok', detail: `${provider.id}: ${result.detail}` }
          : { status: 'down', detail: `${provider.id}: ${result.detail}` };
      });
    },
  };
}

export const fileStorageModule = defineModule<FileStorageConfig>({
  ...moduleDeclarations('file-storage'),
  configSchema: fileStorageConfigSchema,
  tenantScoped: true,
  create: (context) => createFileStorage(context),
});
