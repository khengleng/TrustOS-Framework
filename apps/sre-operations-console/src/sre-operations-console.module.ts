import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuditService, PrismaAuditSink } from '@trustos/audit';
import { Authorizer, createAuthorizer, roleGrantPolicy } from '@trustos/authorization';
import { PolicyAuthorizationGuard } from '@trustos/authorization/nest';
import type { AppConfig } from '@trustos/config';
import { DatabaseModule, PrismaService, checkDatabaseConnection } from '@trustos/database';
import { ObservabilityModule, databaseHealthIndicator } from '@trustos/observability';
import { AuthenticationAssuranceGuard, AuthenticationGuard } from '@trustos/identity/nest';
import type { AccessResolver, CredentialAuthenticator, IdentityProvider } from '@trustos/identity';
import type { Logger } from '@trustos/logging';
import { canGrantRole, PermissionsGuard } from '@trustos/rbac';
import {
  LoggerSecurityEventSink,
  PersistentSecurityEventSink,
  SecurityEventEmitter,
  type SecurityEventSink,
} from '@trustos/security-events';
import type { SecurityPolicy } from '@trustos/security-policy';
import { TenantGuard } from '@trustos/tenancy';
import { ServiceRegistry } from '@trustos/sre-core';
import { SliRegistry } from '@trustos/sli';
import { DependencyHealthBoard } from '@trustos/dependency-health';
import { IncidentManager, InMemoryIncidentSink } from '@trustos/incident-management';
import { OperationsController, type SreState } from './controllers/operations.controller';
import {
  ACCESS_RESOLVER,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  AUDIT_SERVICE,
  AUTHORIZER,
  GUARD_ORDER,
  HEALTH_BOARD,
  IDENTITY_PROVIDER,
  INCIDENT_MANAGER,
  INCIDENT_SINK,
  SECURITY_EVENTS,
  SECURITY_POLICY,
  SERVICE_REGISTRY,
  SLI_REGISTRY,
  SRE_STATE,
} from './tokens';

/**
 * Composition root for the SRE Operations Console.
 *
 * The same guard order as every other TrustOS application. What differs is what the console is
 * allowed to do, and the shape of that is worth stating here rather than in each controller:
 *
 * **This console observes and records; it does not act on production.** There is no route that
 * restarts an instance, drains a node, fails over a database or scales anything. Those actions
 * exist and they belong behind the deployment's own operational tooling, where they are subject to
 * whatever change control that tooling has. A console that could take them would be an
 * unaudited path to production change wearing a dashboard.
 *
 * The one exception is declaring and updating incidents, which is recording rather than acting.
 *
 * **Every registry is in memory**, as in the governance console and for the same reason: a
 * service registration and an objective are documents a deployment loads from configuration.
 */
export interface SreOperationsConsoleOptions {
  config: AppConfig;
  policy: SecurityPolicy;
  logger: Logger;
  overrides?: Partial<{
    identityProvider: IdentityProvider;
    authenticators: CredentialAuthenticator[];
    accessResolver: AccessResolver;
    securityEventSinks: SecurityEventSink[];
    auditService: AuditService;

    serviceRegistry: ServiceRegistry;
    slis: SliRegistry;
    state: SreState;
    /** The clock, so the boot test and a deployment can both pin it. */
    now: () => Date;
  }>;
}

@Global()
@Module({})
export class SreOperationsConsoleModule {
  static forRoot(options: SreOperationsConsoleOptions): DynamicModule {
    const { config, policy, logger, overrides = {} } = options;

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    return {
      module: SreOperationsConsoleModule,
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
      controllers: [OperationsController],
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
              additional: [roleGrantPolicy(canGrantRole)],
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
             * Refuses everything by default. An example that shipped a permissive resolver would
             * be a template for granting access from a token claim.
             */
            ({ resolve: async () => null } satisfies AccessResolver),
        },

        // --- the SRE layer ----------------------------------------------------
        { provide: SERVICE_REGISTRY, useValue: overrides.serviceRegistry ?? new ServiceRegistry() },
        { provide: SLI_REGISTRY, useValue: overrides.slis ?? new SliRegistry() },
        {
          provide: SRE_STATE,
          useValue: overrides.state ?? ({ slos: [], measurements: [], incidents: [] } as SreState),
        },
        { provide: INCIDENT_SINK, useValue: new InMemoryIncidentSink() },

        {
          provide: HEALTH_BOARD,
          inject: [SERVICE_REGISTRY],
          useFactory: (registry: ServiceRegistry) =>
            /*
             * State is derived on read against the clock, which is what makes staleness work: a
             * stored health state never becomes stale by itself, because nothing runs to change it.
             */
            new DependencyHealthBoard(registry, overrides.now ?? (() => new Date())),
        },

        {
          provide: INCIDENT_MANAGER,
          inject: [INCIDENT_SINK, SERVICE_REGISTRY],
          useFactory: (sink: InMemoryIncidentSink, registry: ServiceRegistry) =>
            new IncidentManager({
              sink,
              // Impact is stated in terms of the products a service supports, read from the
              // registry rather than typed by whoever declared the incident.
              registry,
              now: overrides.now ?? (() => new Date()),
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
        SERVICE_REGISTRY,
        SLI_REGISTRY,
        HEALTH_BOARD,
        INCIDENT_MANAGER,
        SRE_STATE,
        GUARD_ORDER,
        DatabaseModule,
      ],
    };
  }
}

/**
 * An identity provider that authenticates nobody.
 *
 * The default, deliberately. This application governs an existing deployment, so it authenticates
 * against whatever that deployment already uses — and a default local provider here would be a
 * second, weaker way in to the surface that decides what everything else may do.
 */
function refusingIdentityProvider(): IdentityProvider {
  const refuse = (): never => {
    throw new Error(
      'No identity provider is configured. This console authenticates against the deployment it ' +
        'observes; wire one in SreOperationsConsoleModule.forRoot.',
    );
  };

  return {
    name: 'unconfigured',
    authenticate: refuse,
    verifyAccessToken: refuse,
    refresh: refuse,
    revoke: refuse,
  } as unknown as IdentityProvider;
}
