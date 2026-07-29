import {
  DynamicModule,
  Global,
  Module,
  type InjectionToken,
  type ModuleMetadata,
} from '@nestjs/common';
import type { AppConfig } from '@trustos/config';
import { HealthRegistry, type HealthIndicator } from '../health';
import { NoopMetricsRecorder, type MetricsRecorder } from '../metrics';
import { NoopTracer, type Tracer } from '../tracing';
import { HEALTH_REGISTRY, HealthController } from './health.controller';

export const METRICS_RECORDER = Symbol.for('trustos.metrics-recorder');
export const TRACER = Symbol.for('trustos.tracer');

export interface ObservabilityModuleOptions {
  config: AppConfig;
  indicators?: HealthIndicator[];
  metrics?: MetricsRecorder;
  tracer?: Tracer;
}

export interface ObservabilityAsyncOptions {
  config: AppConfig;
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  useFactory: (
    ...args: never[]
  ) =>
    | Omit<ObservabilityModuleOptions, 'config'>
    | Promise<Omit<ObservabilityModuleOptions, 'config'>>;
}

/**
 * Registers the probes and the metrics/tracing seams.
 *
 * The defaults are no-ops, so a new service gets working health endpoints
 * without adopting a monitoring stack — which is the point of shipping the
 * seam before the stack.
 */
@Global()
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions): DynamicModule {
    const registry = new HealthRegistry(
      {
        service: options.config.serviceName,
        version: options.config.serviceVersion,
        environment: options.config.env,
      },
      options.indicators ?? [],
    );

    return {
      module: ObservabilityModule,
      controllers: [HealthController],
      providers: [
        { provide: HEALTH_REGISTRY, useValue: registry },
        { provide: METRICS_RECORDER, useValue: options.metrics ?? new NoopMetricsRecorder() },
        { provide: TRACER, useValue: options.tracer ?? new NoopTracer() },
      ],
      exports: [HEALTH_REGISTRY, METRICS_RECORDER, TRACER],
    };
  }

  /**
   * Same, but the health indicators are built from injected providers.
   *
   * Needed because the most important indicator — the database — depends on a
   * client that Nest owns, and a registry assembled at module-definition time
   * cannot see it.
   */
  static forRootAsync(options: ObservabilityAsyncOptions): DynamicModule {
    return {
      module: ObservabilityModule,
      imports: options.imports ?? [],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_REGISTRY,
          inject: options.inject ?? [],
          useFactory: async (...args: never[]) => {
            const resolved = await options.useFactory(...args);
            return new HealthRegistry(
              {
                service: options.config.serviceName,
                version: options.config.serviceVersion,
                environment: options.config.env,
              },
              resolved.indicators ?? [],
            );
          },
        },
        {
          provide: METRICS_RECORDER,
          inject: options.inject ?? [],
          useFactory: async (...args: never[]) =>
            (await options.useFactory(...args)).metrics ?? new NoopMetricsRecorder(),
        },
        {
          provide: TRACER,
          inject: options.inject ?? [],
          useFactory: async (...args: never[]) =>
            (await options.useFactory(...args)).tracer ?? new NoopTracer(),
        },
      ],
      exports: [HEALTH_REGISTRY, METRICS_RECORDER, TRACER],
    };
  }
}
