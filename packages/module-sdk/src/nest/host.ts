import type { Provider } from '@nestjs/common';
import { HEALTH_REGISTRY, type HealthRegistry } from '@trustos/observability';
import {
  createModuleContext,
  InMemoryTenantSettingsStore,
  type ModuleAuditPort,
  type ModuleContext,
  type ModuleEnvironment,
  type PrismaLike,
  type TenantSettingsStore,
} from '../context';
import type { ModuleInstance, TrustosModule } from '../definition';
import type { LoggerPort } from '@trustos/logging';

/**
 * Wiring a module into a NestJS application.
 *
 * The design goal is that a host application says *where its pieces are* and
 * nothing else. It does not construct a module, does not know which stores a
 * module uses, and does not repeat a module's configuration schema.
 *
 * Bindings are explicit rather than resolved from ambient global tokens: the
 * host passes the tokens it already has (`APP_LOGGER`, `AUDIT_SERVICE`,
 * `PrismaService`), so a module never depends on a host having adopted a
 * particular token name. That matters for a package installed into applications
 * this repository has never seen.
 */

/** What a module needs from its host, once resolved. */
export interface ModuleHostContext {
  logger: LoggerPort;
  audit: ModuleAuditPort;
  /** Null when no database is available; the module falls back to memory. */
  prisma?: PrismaLike | null;
  environment?: ModuleEnvironment;
  /** Raw module configuration. Validated by the module's own schema. */
  config?: unknown;
  tenantSettings?: TenantSettingsStore;
}

/**
 * How to obtain a `ModuleHostContext` from the host's own injection tokens.
 *
 * The same shape Nest uses for an async provider, so a host wires a module the
 * way it wires everything else.
 */
export interface ModuleHostBinding {
  inject?: unknown[];
  useFactory: (...dependencies: never[]) => ModuleHostContext;
}

/**
 * Injection tokens, derived from the module id.
 *
 * `Symbol.for` rather than `Symbol`: the token has to be the same symbol in the
 * module package and in the host's generated wiring, and those are separate
 * module instances at runtime once npm has resolved them independently.
 */
export function moduleContextToken(moduleId: string): symbol {
  return Symbol.for(`trustos.module-context.${moduleId}`);
}

export function moduleInstanceToken(moduleId: string): symbol {
  return Symbol.for(`trustos.module-instance.${moduleId}`);
}

export function moduleLifecycleToken(moduleId: string): symbol {
  return Symbol.for(`trustos.module-lifecycle.${moduleId}`);
}

/** Provider for the module's validated `ModuleContext`. */
export function moduleContextProvider<TConfig>(
  module: TrustosModule<TConfig>,
  binding: ModuleHostBinding,
): Provider {
  return {
    provide: moduleContextToken(module.metadata.id),
    inject: (binding.inject ?? []) as never[],
    useFactory: (...dependencies: never[]): ModuleContext<TConfig> => {
      const host = binding.useFactory(...dependencies);

      return createModuleContext<TConfig>({
        moduleId: module.metadata.id,
        configSchema: module.configSchema,
        config: host.config ?? {},
        logger: host.logger,
        audit: host.audit,
        environment: host.environment ?? 'development',
        prisma: host.prisma ?? null,
        tenantSettings: host.tenantSettings ?? new InMemoryTenantSettingsStore(),
      });
    },
  };
}

/**
 * Provider for the module instance.
 *
 * One instance per application, created from the context. The controller and the
 * lifecycle hooks therefore act on the same object — a second instance would
 * mean a queue the controller writes to and a worker that never reads.
 */
export function moduleInstanceProvider<TConfig>(module: TrustosModule<TConfig>): Provider {
  return {
    provide: moduleInstanceToken(module.metadata.id),
    inject: [moduleContextToken(module.metadata.id)],
    useFactory: (context: ModuleContext<TConfig>): ModuleInstance => module.create(context),
  };
}

/**
 * Runs the module's lifecycle and attaches its health indicator.
 *
 * A factory provider rather than a class, because there is one of these per module
 * and Nest calls lifecycle hooks on any provider instance that implements them —
 * so a plain object with `onModuleInit` is enough and avoids generating a class per
 * module id.
 *
 * `HEALTH_REGISTRY` is injected optionally. A host that has no observability module
 * still gets a working module; it just does not see the module in `GET /ready`.
 *
 * Note what this does *not* do: it does not order initialization across modules.
 * Nest initializes in its own import order, which is fine for modules whose
 * `initialize` is independent — as all the framework's are. A host that needs the
 * dependency-ordered, transactional start-up (a worker, say) uses
 * `ModuleRegistry.initializeAll` instead.
 */
export function moduleLifecycleProvider<TConfig>(module: TrustosModule<TConfig>): Provider {
  return {
    provide: moduleLifecycleToken(module.metadata.id),
    inject: [moduleInstanceToken(module.metadata.id), { token: HEALTH_REGISTRY, optional: true }],
    useFactory: (instance: ModuleInstance, registry: HealthRegistry | null) => ({
      async onModuleInit(): Promise<void> {
        await instance.initialize();
        registry?.register(instance.healthIndicator());
      },
      async onModuleDestroy(): Promise<void> {
        await instance.shutdown();
      },
    }),
  };
}

/**
 * The providers every module Nest module needs: context, instance, lifecycle.
 *
 * Add `moduleServiceProvider` alongside to expose whatever the instance carries —
 * a controller should inject the service, not reach through the instance.
 */
export function moduleProviders<TConfig>(
  module: TrustosModule<TConfig>,
  binding: ModuleHostBinding,
): Provider[] {
  return [
    moduleContextProvider(module, binding),
    moduleInstanceProvider(module),
    moduleLifecycleProvider(module),
  ];
}

/** Provider that exposes one member of a module instance under its own token. */
export function moduleServiceProvider<TInstance, TService>(
  moduleId: string,
  token: unknown,
  select: (instance: TInstance) => TService,
): Provider {
  return {
    provide: token as never,
    inject: [moduleInstanceToken(moduleId)],
    useFactory: (instance: TInstance) => select(instance),
  };
}
