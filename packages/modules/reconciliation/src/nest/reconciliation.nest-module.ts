import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustsystem/module-sdk/nest';
import { reconciliationModule } from '../reconciliation.module';

/**
 * NestJS wiring for the reconciliation module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes a store the application supplies.
 */
@Module({})
export class ReconciliationModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: ReconciliationModule,
      providers: [...moduleProviders(reconciliationModule, binding)],
      exports: [],
    };
  }
}
