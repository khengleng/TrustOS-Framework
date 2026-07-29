import { DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '@trustos/config';
import type { Logger } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import { APP_CONFIG_TOKEN, APP_LOGGER, APP_METRICS } from '../tokens';

/**
 * Makes the process-wide singletons injectable everywhere.
 *
 * Config, logger and metrics are created in `main.ts` before Nest starts —
 * configuration must be validated before anything else runs — so they enter
 * the container as values rather than as providers Nest constructs.
 */
@Global()
@Module({})
export class CoreModule {
  static forRoot(options: {
    config: AppConfig;
    logger: Logger;
    metrics: MetricsRecorder;
  }): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: APP_CONFIG_TOKEN, useValue: options.config },
        { provide: APP_LOGGER, useValue: options.logger },
        { provide: APP_METRICS, useValue: options.metrics },
      ],
      exports: [APP_CONFIG_TOKEN, APP_LOGGER, APP_METRICS],
    };
  }
}
