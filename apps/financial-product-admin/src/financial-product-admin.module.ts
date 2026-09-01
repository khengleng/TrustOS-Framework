import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuditService, PrismaAuditSink } from '@trustsystem/audit';
import { Authorizer, createAuthorizer, roleGrantPolicy } from '@trustsystem/authorization';
import { PolicyAuthorizationGuard } from '@trustsystem/authorization/nest';
import type { AppConfig } from '@trustsystem/config';
import { DatabaseModule, PrismaService, checkDatabaseConnection } from '@trustsystem/database';
import { ObservabilityModule, databaseHealthIndicator } from '@trustsystem/observability';
import { AuthenticationAssuranceGuard, AuthenticationGuard } from '@trustsystem/identity/nest';
import type {
  AccessResolver,
  CredentialAuthenticator,
  IdentityProvider,
} from '@trustsystem/identity';
import type { Logger } from '@trustsystem/logging';
import { canGrantRole, PermissionsGuard } from '@trustsystem/rbac';
import {
  LoggerSecurityEventSink,
  PersistentSecurityEventSink,
  SecurityEventEmitter,
  type SecurityEventSink,
} from '@trustsystem/security-events';
import type { SecurityPolicy } from '@trustsystem/security-policy';
import { TenantGuard } from '@trustsystem/tenancy';
import {
  collectingAuditRecorder,
  collectingEventPublisher,
  structuralReferenceData,
  type ProductAuditRecorder,
  type ProductEventPublisher,
  type ReferenceDataRegistry,
} from '@trustsystem/financial-product-core';
import { FINANCIAL_PRODUCT_POLICIES } from '@trustsystem/financial-product-policy';
import { APPROVED_BLOCKS, BlockRegistry } from '@trustsystem/financial-block-registry';
import { ConnectorRegistry } from '@trustsystem/connector-registry';
import {
  InMemoryProductStore,
  ProductRegistry,
  type ProductStore,
} from '@trustsystem/financial-product-registry';
import { BlockHandlerRegistry, ProductRuntime } from '@trustsystem/financial-product-runtime';
import { MetricCollector, guardedSink } from '@trustsystem/financial-product-observability';
import { CatalogController } from './controllers/catalog.controller';
import { ComposerController } from './controllers/composer.controller';
import { DesignerController } from './controllers/designer.controller';
import { ExerciseController } from './controllers/exercise.controller';
import { MonitoringController } from './controllers/monitoring.controller';
import {
  ACCESS_RESOLVER,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  AUDIT_SERVICE,
  AUTHORIZER,
  BLOCK_REGISTRY,
  CONNECTOR_REGISTRY,
  GUARD_ORDER,
  IDENTITY_PROVIDER,
  METRIC_COLLECTOR,
  PRODUCT_REGISTRY,
  PRODUCT_RUNTIME,
  PRODUCT_STORE,
  REFERENCE_DATA,
  SECURITY_EVENTS,
  SECURITY_POLICY,
} from './tokens';

/**
 * Composition root for the Financial Product Designer.
 *
 * This is the phase's integration proof as much as it is an example: the sixteen packages added
 * in phase 11 are wired here against the real framework, and `financial-product-admin.spec.ts`
 * boots it and asserts the guards resolve in order and the routes map.
 *
 * The guard order is the security model. Nest applies `APP_GUARD` providers in registration
 * order, so the array below *is* the order:
 *
 *   AuthenticationGuard           who is calling?              -> request.actor
 *   TenantGuard                   whose data may they see?     -> request.organizationId
 *   AuthenticationAssuranceGuard  did they prove it strongly enough?
 *   PermissionsGuard              may they do this at all?     (deny by default)
 *   PolicyAuthorizationGuard      does the full policy set allow it?
 *
 * Each one can only refuse, and `PolicyAuthorizationGuard` is last because it is the only one
 * with the full picture — it is where the financial product policies live, so separation of duty
 * is checked after identity, tenancy and permissions are settled.
 *
 * **The product store is in memory, and that is a stated limitation rather than a design.** Phase
 * 11 adds no Prisma models: a product definition is a document, and which shape it takes in a
 * database is a decision a deployment makes against its own retention, replication and access
 * rules. `ProductStore` is the port, its three atomicity contracts are documented on the
 * interface, and `InMemoryProductStore` is what the boot test and the sandbox run against. A
 * deployment binds a Prisma implementation and passes it as an override.
 */

export interface FinancialProductAdminOptions {
  config: AppConfig;
  policy: SecurityPolicy;
  logger: Logger;
  /** Overridden by the boot test, so it needs no database. */
  overrides?: Partial<{
    identityProvider: IdentityProvider;
    authenticators: CredentialAuthenticator[];
    accessResolver: AccessResolver;
    securityEventSinks: SecurityEventSink[];
    auditService: AuditService;
    /** The persistent store a deployment supplies. */
    productStore: ProductStore;
    /** Where product audit records go. Defaults to a collector; a deployment wires @trustsystem/audit. */
    productAudit: ProductAuditRecorder;
    /** Where product events go. Defaults to a collector; a deployment wires @trustsystem/event-bus. */
    productEvents: ProductEventPublisher;
    blocks: BlockRegistry;
    connectors: ConnectorRegistry;
    referenceData: ReferenceDataRegistry;
    /**
     * Block handlers.
     *
     * Empty by default, and that is the seam. The framework ships no handler for any block: a
     * deployment binds `wallet.debit` to `@trustsystem/wallet`, `ledger.*` to `@trustsystem/ledger` and
     * the rest, and the runtime refuses an unbound block rather than skipping it.
     */
    handlers: BlockHandlerRegistry;
  }>;
}

@Global()
@Module({})
export class FinancialProductAdminModule {
  static forRoot(options: FinancialProductAdminOptions): DynamicModule {
    const { config, policy, logger, overrides = {} } = options;

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    const collector = new MetricCollector();

    return {
      module: FinancialProductAdminModule,
      imports: [
        DatabaseModule.forRoot({ config, logger }),
        /*
         * Health and readiness.
         *
         * Added after a deployment found their absence: the platform probes `/health`, the route
         * did not exist, and the container was killed as unhealthy having started perfectly well.
         *
         * AGENTS.md states the rule — every deployable HTTP service exposes both — and six
         * applications in this repository did not, because nothing had ever deployed them.
         *
         * `/health` answers without touching a dependency and `/ready` consults the database, so a
         * database blip degrades readiness rather than restarting the container.
         */
        ObservabilityModule.forRootAsync({
          config,
          inject: [PrismaService],
          useFactory: ((prisma: PrismaService) => ({
            indicators: [databaseHealthIndicator(() => checkDatabaseConnection(prisma))],
          })) as never,
        }),
      ],
      controllers: [
        CatalogController,
        ComposerController,
        DesignerController,
        ExerciseController,
        MonitoringController,
      ],
      providers: [
        { provide: APP_CONFIG_TOKEN, useValue: config },
        { provide: APP_LOGGER, useValue: logger },
        { provide: SECURITY_POLICY, useValue: policy },

        // --- shared framework services ---------------------------------------
        ...(overrides.auditService
          ? [{ provide: AUDIT_SERVICE, useValue: overrides.auditService }]
          : [
              {
                provide: AUDIT_SERVICE,
                inject: [PrismaService],
                useFactory: (prisma: PrismaService) =>
                  new AuditService({ sink: new PrismaAuditSink(prisma), logger }),
              } satisfies Provider,
            ]),

        {
          provide: SECURITY_EVENTS,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) =>
            new SecurityEventEmitter({
              application: config.serviceName,
              logger,
              sinks: overrides.securityEventSinks ?? [
                new LoggerSecurityEventSink(logger),
                new PersistentSecurityEventSink(prisma.securityEvent),
              ],
            }),
        },

        {
          provide: AUTHORIZER,
          inject: [SECURITY_EVENTS],
          useFactory: (events: SecurityEventEmitter): Authorizer =>
            createAuthorizer({
              mfa: policy.mfa,
              events,
              application: config.serviceName,
              /*
               * The financial product policies, on top of the framework's standard set.
               *
               * Every one of them can only *refuse* — none returns `allow` — so adding them can
               * only make the system stricter. `roleGrantPolicy` is kept because a product that
               * assigned a role would otherwise bypass the phase 4 escalation check.
               */
              additional: [...FINANCIAL_PRODUCT_POLICIES, roleGrantPolicy(canGrantRole)],
            }),
        },

        {
          provide: IDENTITY_PROVIDER,
          useValue: overrides.identityProvider ?? refusingIdentityProvider(),
        },

        {
          provide: ACCESS_RESOLVER,
          useValue:
            overrides.accessResolver ??
            /*
             * The default resolver refuses everything, deliberately. An example that shipped a
             * permissive resolver would be a template for granting access from a token claim.
             */
            ({ resolve: async () => null } satisfies AccessResolver),
        },

        // --- the product layer -----------------------------------------------
        { provide: BLOCK_REGISTRY, useValue: overrides.blocks ?? APPROVED_BLOCKS },
        { provide: CONNECTOR_REGISTRY, useValue: overrides.connectors ?? new ConnectorRegistry() },
        {
          provide: REFERENCE_DATA,
          useValue: overrides.referenceData ?? structuralReferenceData(),
        },
        { provide: PRODUCT_STORE, useValue: overrides.productStore ?? new InMemoryProductStore() },
        { provide: METRIC_COLLECTOR, useValue: collector },

        {
          provide: PRODUCT_REGISTRY,
          inject: [PRODUCT_STORE, BLOCK_REGISTRY, CONNECTOR_REGISTRY, REFERENCE_DATA],
          useFactory: (
            store: ProductStore,
            blocks: BlockRegistry,
            connectors: ConnectorRegistry,
            referenceData: ReferenceDataRegistry,
          ) =>
            new ProductRegistry({
              store,
              audit: overrides.productAudit ?? collectingAuditRecorder(),
              /*
               * The connector registry is passed to validation, which makes an unbound provider
               * interface an **error** rather than a note. That is the right severity here: this
               * application publishes products, and a product published with nothing bound fails
               * at the first transaction with earlier blocks already run.
               */
              validation: { blocks, connectors, referenceData },
            }),
        },

        {
          provide: PRODUCT_RUNTIME,
          inject: [BLOCK_REGISTRY, CONNECTOR_REGISTRY],
          useFactory: (blocks: BlockRegistry, connectors: ConnectorRegistry) =>
            new ProductRuntime({
              handlers: overrides.handlers ?? new BlockHandlerRegistry(),
              events: overrides.productEvents ?? collectingEventPublisher(),
              audit: overrides.productAudit ?? collectingAuditRecorder(),
              blocks,
              connectors,
              // Guarded, so a dimension added during an incident is refused at emission rather
              // than discovered in a bill.
              metrics: guardedSink(collector),
            }),
        },

        // --- guards, in order ------------------------------------------------
        orderedGuard(AuthenticationGuard, {
          provide: APP_GUARD,
          inject: [Reflector, IDENTITY_PROVIDER, ACCESS_RESOLVER, SECURITY_EVENTS],
          useFactory: (reflector: Reflector) =>
            new AuthenticationGuard(reflector, overrides.authenticators ?? [], {}),
        }),

        orderedGuard(TenantGuard, { provide: APP_GUARD, useClass: TenantGuard }),

        orderedGuard(AuthenticationAssuranceGuard, {
          provide: APP_GUARD,
          inject: [Reflector, SECURITY_EVENTS],
          useFactory: (reflector: Reflector, events: SecurityEventEmitter) =>
            new AuthenticationAssuranceGuard(reflector, policy.mfa, { events }),
        }),

        orderedGuard(PermissionsGuard, { provide: APP_GUARD, useClass: PermissionsGuard }),

        orderedGuard(PolicyAuthorizationGuard, {
          provide: APP_GUARD,
          inject: [Reflector, AUTHORIZER],
          useFactory: (reflector: Reflector, authorizer: Authorizer) =>
            new PolicyAuthorizationGuard(reflector, authorizer),
        }),

        { provide: GUARD_ORDER, useFactory: () => [...guardOrder] },
      ],
      exports: [
        APP_CONFIG_TOKEN,
        APP_LOGGER,
        SECURITY_POLICY,
        SECURITY_EVENTS,
        AUDIT_SERVICE,
        AUTHORIZER,
        PRODUCT_REGISTRY,
        PRODUCT_RUNTIME,
        PRODUCT_STORE,
        BLOCK_REGISTRY,
        CONNECTOR_REGISTRY,
        REFERENCE_DATA,
        METRIC_COLLECTOR,
        GUARD_ORDER,
        DatabaseModule,
      ],
    };
  }
}

/**
 * An identity provider that authenticates nobody.
 *
 * The default, deliberately. This application administers an existing deployment's products, so
 * it must authenticate against whatever that deployment already uses — and a default local
 * provider here would be a second, weaker way in to the same data.
 */
function refusingIdentityProvider(): IdentityProvider {
  const refuse = (): never => {
    throw new Error(
      'No identity provider is configured. This application authenticates against the deployment ' +
        'it administers; wire one in FinancialProductAdminModule.forRoot.',
    );
  };

  return {
    name: 'unconfigured',
    findUserByEmail: refuse,
    findUserById: refuse,
    createUser: refuse,
  } as unknown as IdentityProvider;
}
