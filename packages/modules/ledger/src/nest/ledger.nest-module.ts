import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { ledgerModule } from '../ledger.module';

/**
 * NestJS wiring for the ledger module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes a store the application supplies.
 */
@Module({})
export class LedgerModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: LedgerModule,
      providers: [...moduleProviders(ledgerModule, binding)],
      exports: [],
    };
  }
}
