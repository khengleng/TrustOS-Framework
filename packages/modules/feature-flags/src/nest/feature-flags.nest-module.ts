import { DynamicModule, Module } from '@nestjs/common';
import {
  moduleProviders,
  moduleServiceProvider,
  type ModuleHostBinding,
} from '@trustsystem/module-sdk/nest';
import { featureFlagsModule, type FeatureFlagsInstance } from '../feature-flags.module';
import { FeatureFlagsController } from './feature-flags.controller';
import { FEATURE_FLAGS_SERVICE } from './tokens';

/**
 * NestJS wiring for the feature-flags module.
 *
 * The service is exported so product code can gate its own behaviour on a flag
 * rather than inventing a second configuration mechanism.
 */
@Module({})
export class FeatureFlagsModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: FeatureFlagsModule,
      controllers: [FeatureFlagsController],
      providers: [
        ...moduleProviders(featureFlagsModule, binding),
        moduleServiceProvider<FeatureFlagsInstance, FeatureFlagsInstance['service']>(
          'feature-flags',
          FEATURE_FLAGS_SERVICE,
          (instance) => instance.service,
        ),
      ],
      exports: [FEATURE_FLAGS_SERVICE],
    };
  }
}
