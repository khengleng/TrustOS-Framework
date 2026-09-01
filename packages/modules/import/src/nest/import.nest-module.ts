import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustsystem/module-sdk/nest';
import { importModule } from '../import.module';

/**
 * NestJS wiring for the import module.
 *
 * Registers the lifecycle and the health indicator. The framework packages have their own Nest
 * modules for the services themselves — importing this one does not import those, so an
 * application chooses what it actually wires.
 */
@Module({})
export class ImportModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: ImportModule,
      providers: [...moduleProviders(importModule, binding)],
      exports: [],
    };
  }
}
