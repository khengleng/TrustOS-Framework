import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type InjectionToken,
  type ModuleMetadata,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { LoggerPort } from '@trustos/logging';
import type { MetricsRecorder } from '@trustos/observability';
import {
  EventRegistry,
  STANDARD_EVENTS,
  type EventSchemaDefinition,
} from '@trustos/event-registry';
import type { DeadLetterStore, DeliveryLedger, EventBus } from '../contracts';
import { InMemoryEventBus } from '../in-memory-bus';
import { DeadLetterReplayService } from '../replay';

export const EVENT_BUS = Symbol.for('trustos.event-bus');
export const EVENT_REGISTRY = Symbol.for('trustos.event-registry');
export const DEAD_LETTER_STORE = Symbol.for('trustos.dead-letter-store');

export interface EventBusModuleOptions {
  /**
   * The application's own event schemas.
   *
   * Registered alongside the framework's standard events unless `includeStandardEvents` says
   * otherwise. A conflict throws at start-up, which is the only time it can be fixed cheaply.
   */
  schemas?: EventSchemaDefinition[];

  /** Defaults to true. False for an application that wants to publish nothing but its own. */
  includeStandardEvents?: boolean;

  /**
   * A durable bus.
   *
   * Omit for the in-memory default. This is where a deployment plugs in whatever transport it
   * chose — the framework ships none, because that choice has operational consequences the
   * framework cannot weigh.
   */
  bus?: EventBus;

  deadLetters?: DeadLetterStore;
  ledger?: DeliveryLedger;
  logger?: LoggerPort;
  metrics?: MetricsRecorder;
}

export interface EventBusAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  useFactory: (...args: never[]) => EventBusModuleOptions | Promise<EventBusModuleOptions>;
}

/**
 * Registers the bus, the registry and dead-letter replay.
 *
 * Global, because a publisher is any service in the application and threading an import through
 * every module that reports a fact is the kind of friction that ends with somebody calling a
 * service directly instead.
 *
 * `drain` is wired to the Nest shutdown hook, so `app.enableShutdownHooks()` is what makes a
 * deployment stop losing in-flight handlers on restart. Without that call the bus never learns
 * the process is going away.
 */
@Global()
@Module({})
export class EventBusModule {
  static forRoot(options: EventBusModuleOptions = {}): DynamicModule {
    return {
      module: EventBusModule,
      providers: [
        { provide: EVENT_REGISTRY, useFactory: () => buildRegistry(options) },
        {
          provide: EVENT_BUS,
          inject: [EVENT_REGISTRY],
          useFactory: (registry: EventRegistry) => buildBus(options, registry),
        },
        {
          provide: DEAD_LETTER_STORE,
          useValue: options.deadLetters ?? null,
        },
        {
          provide: DeadLetterReplayService,
          inject: [EVENT_BUS],
          useFactory: (bus: EventBus) =>
            options.deadLetters
              ? new DeadLetterReplayService({
                  bus,
                  store: options.deadLetters,
                  logger: options.logger,
                })
              : null,
        },
        EventBusShutdownHook,
      ],
      exports: [EVENT_BUS, EVENT_REGISTRY, DEAD_LETTER_STORE, DeadLetterReplayService],
    };
  }

  static forRootAsync(options: EventBusAsyncOptions): DynamicModule {
    /*
     * The factory is called once and its result shared.
     *
     * Three providers each calling it would build three registries and — worse — three buses, so
     * a subscriber registered against one would never see an event published to another. That
     * failure is silent, which is why the resolution is memoised here rather than left to each
     * provider.
     */
    const RESOLVED = Symbol.for('trustos.event-bus.resolved-options');

    return {
      module: EventBusModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: RESOLVED,
          inject: options.inject ?? [],
          useFactory: (...args: never[]) => options.useFactory(...args),
        },
        {
          provide: EVENT_REGISTRY,
          inject: [RESOLVED],
          useFactory: (resolved: EventBusModuleOptions) => buildRegistry(resolved),
        },
        {
          provide: EVENT_BUS,
          inject: [RESOLVED, EVENT_REGISTRY],
          useFactory: (resolved: EventBusModuleOptions, registry: EventRegistry) =>
            buildBus(resolved, registry),
        },
        {
          provide: DEAD_LETTER_STORE,
          inject: [RESOLVED],
          useFactory: (resolved: EventBusModuleOptions) => resolved.deadLetters ?? null,
        },
        {
          provide: DeadLetterReplayService,
          inject: [RESOLVED, EVENT_BUS],
          useFactory: (resolved: EventBusModuleOptions, bus: EventBus) =>
            resolved.deadLetters
              ? new DeadLetterReplayService({
                  bus,
                  store: resolved.deadLetters,
                  logger: resolved.logger,
                })
              : null,
        },
        EventBusShutdownHook,
      ],
      exports: [EVENT_BUS, EVENT_REGISTRY, DEAD_LETTER_STORE, DeadLetterReplayService],
    };
  }
}

/**
 * Drains the bus when the process is shutting down.
 *
 * A provider rather than a lifecycle method on the bus itself, because `EventBus` is an
 * interface a deployment may implement with something that knows nothing about Nest — and
 * requiring every implementation to carry a framework decorator would defeat the abstraction.
 *
 * This only runs if the application calls `app.enableShutdownHooks()`. Without it Nest never
 * signals shutdown, and in-flight handlers die with the process.
 */
@Injectable()
export class EventBusShutdownHook implements OnApplicationShutdown {
  constructor(@Inject(EVENT_BUS) private readonly bus: EventBus) {}

  async onApplicationShutdown(): Promise<void> {
    await this.bus.drain();
  }
}

function buildRegistry(options: EventBusModuleOptions): EventRegistry {
  const registry = new EventRegistry();

  if (options.includeStandardEvents !== false) registry.registerAll(STANDARD_EVENTS);
  if (options.schemas) registry.registerAll(options.schemas);

  return registry;
}

function buildBus(options: EventBusModuleOptions, registry: EventRegistry): EventBus {
  return (
    options.bus ??
    new InMemoryEventBus({
      registry,
      deadLetters: options.deadLetters,
      ledger: options.ledger,
      logger: options.logger,
      metrics: options.metrics,
    })
  );
}
