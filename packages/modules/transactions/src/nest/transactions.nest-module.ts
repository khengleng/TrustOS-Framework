import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { transactionsModule } from '../transactions.module';

/**
 * NestJS wiring for the transactions module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes a store the application supplies.
 */
@Module({})
export class TransactionsModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: TransactionsModule,
      providers: [...moduleProviders(transactionsModule, binding)],
      exports: [],
    };
  }
}
