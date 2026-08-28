import { DynamicModule, Module } from '@nestjs/common';
import {
  moduleProviders,
  moduleServiceProvider,
  type ModuleHostBinding,
} from '@trustos/module-sdk/nest';
import { fileStorageModule } from '../file-storage.module';
import type { FileStorageInstance } from '../file-storage.module';
import { FileStorageController } from './file-storage.controller';
import { FILE_STORAGE_SERVICE } from './tokens';

/**
 * NestJS wiring for the file-storage module.
 *
 * The host says where its logger, audit service and Prisma client are; nothing
 * else. The module builds its own context, validates its own configuration and
 * constructs its own provider and store.
 */
@Module({})
export class FileStorageModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: FileStorageModule,
      controllers: [FileStorageController],
      providers: [
        ...moduleProviders(fileStorageModule, binding),
        moduleServiceProvider<FileStorageInstance, FileStorageInstance['service']>(
          'file-storage',
          FILE_STORAGE_SERVICE,
          (instance) => instance.service,
        ),
      ],
      // Exported so a product module can store its own files through the same
      // service rather than reaching for a provider of its own.
      exports: [FILE_STORAGE_SERVICE],
    };
  }
}
