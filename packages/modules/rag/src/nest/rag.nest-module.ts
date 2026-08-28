import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { ragModule } from '../rag.module';

/**
 * NestJS wiring for the retrieval-augmented generation module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes ports — a store, an adapter, a vector database —
 * that only the application knows.
 */
@Module({})
export class RagModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: RagModule,
      providers: [...moduleProviders(ragModule, binding)],
      exports: [],
    };
  }
}
