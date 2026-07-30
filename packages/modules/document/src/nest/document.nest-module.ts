import { DynamicModule, Module } from '@nestjs/common';
import {
  moduleProviders,
  moduleServiceProvider,
  type ModuleHostBinding,
} from '@trustos/module-sdk/nest';
import { documentModule, type DocumentInstance } from '../document.module';
import { DocumentController } from './document.controller';
import { DOCUMENT_SERVICE } from './tokens';

/**
 * NestJS wiring for the document module.
 *
 * The file-storage module must be installed too — the registry refuses to order
 * a start-up where it is missing — but there is no Nest-level import between
 * them: document uses file-storage's provider port, not its service.
 */
@Module({})
export class DocumentModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: DocumentModule,
      controllers: [DocumentController],
      providers: [
        ...moduleProviders(documentModule, binding),
        moduleServiceProvider<DocumentInstance, DocumentInstance['service']>(
          'document',
          DOCUMENT_SERVICE,
          (instance) => instance.service,
        ),
      ],
      exports: [DOCUMENT_SERVICE],
    };
  }
}
