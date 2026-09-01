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
import { ApiCatalog } from '@trustsystem/api-catalog';
import { ConsumerRegistry } from '@trustsystem/api-consumer';
import { InMemoryQuotaUsageStore, type QuotaUsageStore } from '@trustsystem/api-quota';
import { PortalController, type PortalState } from './controllers/portal.controller';
import {
  ACCESS_RESOLVER,
  API_CATALOG,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  AUDIT_SERVICE,
  AUTHORIZER,
  CONSUMER_REGISTRY,
  GUARD_ORDER,
  IDENTITY_PROVIDER,
  KEY_METADATA,
  PORTAL_STATE,
  QUOTA_STORE,
  SECURITY_EVENTS,
  SECURITY_POLICY,
} from './tokens';

/**
 * Composition root for the API Developer Portal.
 *
 * The same guard order as every other TrustOS application, and one thing worth stating at the
 * composition root because it constrains every controller: **the portal has no write path into the
 * API catalog or the consumer registry.** Both are provided read-only in effect — nothing here
 * publishes an API, and an approved access request produces a consumer through the registry rather
 * than by editing one.
 *
 * That is what keeps the portal from becoming a second, weaker administration surface for the
 * thing it documents.
 */
export interface ApiDeveloperPortalOptions {
  config: AppConfig;
  policy: SecurityPolicy;
  logger: Logger;
  overrides?: Partial<{
    identityProvider: IdentityProvider;
    authenticators: CredentialAuthenticator[];
    accessResolver: AccessResolver;
    securityEventSinks: SecurityEventSink[];
    auditService: AuditService;

    apiCatalog: ApiCatalog;
    consumers: ConsumerRegistry;
    state: PortalState;
    quotaStore: QuotaUsageStore;
    /** Reads credential metadata from `@trustsystem/api-keys`. Never returns a key. */
    keyMetadata: (credentialId: string) => {
      keyPrefix: string;
      name: string;
      createdAt: string;
      expiresAt: string | null;
      lastUsedAt: string | null;
    } | null;
  }>;
}

@Global()
@Module({})
export class ApiDeveloperPortalModule {
  static forRoot(options: ApiDeveloperPortalOptions): DynamicModule {
    const { config, policy, logger, overrides = {} } = options;

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    return {
      module: ApiDeveloperPortalModule,
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
      controllers: [PortalController],
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
             * Refuses everything by default. This is the surface most exposed to the internet;
             * a permissive default here would be an open door with documentation attached.
             */
            ({ resolve: async () => null } satisfies AccessResolver),
        },

        // --- the portal layer --------------------------------------------------
        { provide: API_CATALOG, useValue: overrides.apiCatalog ?? new ApiCatalog() },
        { provide: CONSUMER_REGISTRY, useValue: overrides.consumers ?? new ConsumerRegistry() },
        { provide: QUOTA_STORE, useValue: overrides.quotaStore ?? new InMemoryQuotaUsageStore() },
        {
          provide: KEY_METADATA,
          // Absent by default. A portal with no key store shows the credential reference and says
          // the key is not stored — true and unhelpful, rather than helpful and wrong.
          useValue: overrides.keyMetadata ?? null,
        },
        {
          provide: PORTAL_STATE,
          useValue:
            overrides.state ??
            ({ registrations: [], requests: [], migrationPlans: [], quotas: [] } as PortalState),
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
        API_CATALOG,
        CONSUMER_REGISTRY,
        PORTAL_STATE,
        QUOTA_STORE,
        KEY_METADATA,
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
      'No identity provider is configured. The portal authenticates against the deployment whose ' +
        'APIs it documents; wire one in ApiDeveloperPortalModule.forRoot.',
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
