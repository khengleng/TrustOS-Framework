import { DynamicModule, Module } from '@nestjs/common';
import {
  moduleProviders,
  moduleServiceProvider,
  type ModuleHostBinding,
} from '@trustos/module-sdk/nest';
import { searchModule, type SearchInstance } from '../search.module';
import { SearchController } from './search.controller';
import { SEARCH_SERVICE } from './tokens';

/**
 * NestJS wiring for the search module.
 *
 * The service is exported because an application has to reach it to register its
 * adapters — search has nothing to search until it does.
 */
@Module({})
export class SearchModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: SearchModule,
      controllers: [SearchController],
      providers: [
        ...moduleProviders(searchModule, binding),
        moduleServiceProvider<SearchInstance, SearchInstance['service']>(
          'search',
          SEARCH_SERVICE,
          (instance) => instance.service,
        ),
      ],
      exports: [SEARCH_SERVICE],
    };
  }
}
