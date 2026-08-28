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
import {
  InternalAppCatalog,
  consoleCatalogFor,
  type Environment,
} from '@trustos/governance-tool-core';
import { GovernanceAuditBridge } from '@trustos/governance-audit-bridge';
import {
  EnvironmentRegistry,
  environmentConfigSchema,
} from '@trustos/governance-environment-config';
import { MaskPolicy } from '@trustos/governance-pii-policy';
import { ResourceRegistry } from '@trustos/governance-resource-policy';
import { GovernanceToolRuntime } from '@trustos/governance-tool-runtime';
import { CatalogController } from './controllers/catalog.controller';
import { ConsoleController } from './controllers/console.controller';
import {
  ACCESS_RESOLVER,
  APP_CATALOG,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  AUDIT_SERVICE,
  AUTHORIZER,
  ENVIRONMENT_REGISTRY,
  GATEWAY_ENVIRONMENT,
  GOVERNANCE_AUDIT,
  GOVERNANCE_RUNTIME,
  GUARD_ORDER,
  IDENTITY_PROVIDER,
  RESOURCE_REGISTRY,
  SECURITY_EVENTS,
  SECURITY_POLICY,
} from './tokens';

/**
 * The Governance Tool.
 *
 * The catalog of internal applications, the console templates, the resource registry behind them
 * and the promotion that moves an application between environments.
 *
 * **This application serves descriptors. It carries no traffic.** Reads and actions go through
 * `@trustos/internal-app-gateway`, which is a separate deployable for a reason: the surface that
 * lists what exists and the surface that reaches production data have different blast radii, and
 * running them in one process means one vulnerability reaches both.
 *
 * The guard order is the security model, and it is the same five as everywhere else in this
 * framework.
 */

export interface GovernanceToolOptions {
  config: AppConfig;
  policy: SecurityPolicy;
  logger: Logger;
  /** Which environment this gateway serves. DEV, UAT and PROD run separate instances. */
  environment: Environment;
  overrides?: Partial<{
    identityProvider: IdentityProvider;
    authenticators: CredentialAuthenticator[];
    accessResolver: AccessResolver;
    securityEventSinks: SecurityEventSink[];
    auditService: AuditService;
    resources: ResourceRegistry;
    environments: EnvironmentRegistry;
    apps: InternalAppCatalog;
    masking: MaskPolicy;
  }>;
}

@Global()
@Module({})
export class GovernanceToolModule {
  static forRoot(options: GovernanceToolOptions): DynamicModule {
    const { config, policy, logger, environment, overrides = {} } = options;

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    return {
      module: GovernanceToolModule,
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
      controllers: [CatalogController, ConsoleController],
      providers: [
        { provide: APP_CONFIG_TOKEN, useValue: config },
        { provide: APP_LOGGER, useValue: logger },
        { provide: SECURITY_POLICY, useValue: policy },
        { provide: GATEWAY_ENVIRONMENT, useValue: environment },

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
            overrides.accessResolver ?? ({ resolve: async () => null } satisfies AccessResolver),
        },

        // --- governance ------------------------------------------------------
        {
          provide: RESOURCE_REGISTRY,
          /*
           * Empty by default, and that is the correct default.
           *
           * A gateway that shipped a populated resource registry would be shipping somebody's
           * database credentials and access classes — which are facts about a deployment, not
           * about TrustOS. Until a deployment registers its own, every read is refused with
           * "no approved resource", which is the honest answer.
           */
          useValue: overrides.resources ?? new ResourceRegistry(),
        },

        {
          provide: ENVIRONMENT_REGISTRY,
          useValue:
            overrides.environments ??
            new EnvironmentRegistry([
              environmentConfigSchema.parse({
                environment,
                label: environment.toUpperCase(),
                gatewayRef: `gateway://${environment}`,
                credentialRefs: {},
                editable: environment !== 'prod',
                carriesProductionData: environment === 'prod',
                promotionApprovals:
                  environment === 'prod' ? ['security', 'operations'] : ['operations'],
              }),
            ]),
        },

        { provide: APP_CATALOG, useValue: overrides.apps ?? consoleCatalogFor(environment) },

        {
          provide: GOVERNANCE_AUDIT,
          inject: [AUDIT_SERVICE],
          useFactory: (audit: AuditService) =>
            new GovernanceAuditBridge({ audit, application: config.serviceName, environment }),
        },

        {
          provide: GOVERNANCE_RUNTIME,
          inject: [RESOURCE_REGISTRY, ENVIRONMENT_REGISTRY, GOVERNANCE_AUDIT],
          useFactory: (
            registry: ResourceRegistry,
            environments: EnvironmentRegistry,
            audit: GovernanceAuditBridge,
          ) =>
            new GovernanceToolRuntime({
              registry,
              environments,
              audit,
              masking: overrides.masking ?? new MaskPolicy(),
              environment,
            }),
        },

        // --- guards, in order --------------------------------------------------
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
        RESOURCE_REGISTRY,
        ENVIRONMENT_REGISTRY,
        GOVERNANCE_AUDIT,
        GOVERNANCE_RUNTIME,
        APP_CATALOG,
        GATEWAY_ENVIRONMENT,
        GUARD_ORDER,
        DatabaseModule,
      ],
    };
  }
}

function refusingIdentityProvider(): IdentityProvider {
  const refuse = (): never => {
    throw new Error(
      'No identity provider is configured. The gateway authenticates against the deployment’s ' +
        'enterprise identity; wire one in GovernanceToolModule.forRoot.',
    );
  };

  return {
    name: 'unconfigured',
    findUserByEmail: refuse,
    findUserById: refuse,
    createUser: refuse,
  } as unknown as IdentityProvider;
}
