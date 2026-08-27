import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuditService, PrismaAuditSink } from '@trustos/audit';
import { Authorizer, createAuthorizer, roleGrantPolicy } from '@trustos/authorization';
import { PolicyAuthorizationGuard } from '@trustos/authorization/nest';
import type { AppConfig } from '@trustos/config';
import { DatabaseModule, PrismaService } from '@trustos/database';
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
import { GatewayController } from './controllers/gateway.controller';
import {
  ACCESS_RESOLVER,
  APP_CATALOG,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  AUDIT_SERVICE,
  AUTHORIZER,
  ENVIRONMENT_REGISTRY,
  GOVERNANCE_AUDIT,
  GOVERNANCE_RUNTIME,
  GUARD_ORDER,
  IDENTITY_PROVIDER,
  MASK_POLICY,
  RESOURCE_REGISTRY,
  SECURITY_EVENTS,
  SECURITY_POLICY,
} from './tokens';

/**
 * The internal app gateway.
 *
 * One entrance, for every internal application. That is the whole architecture, and the reason
 * it is worth an application of its own: identity, tenancy, authorization, the access classes,
 * correlation and audit enrichment happen here, so an internal tool that wanted to skip one of
 * them would have to stop calling the gateway — which is a change somebody notices.
 *
 * The guard order is the security model, and it is the same five as everywhere else in this
 * framework. `PolicyAuthorizationGuard` is last because it is the only one with the full picture.
 *
 * **The gateway forwards nothing in this example.** It resolves the application, plans the read
 * or the mutation, checks the declared operation and returns what *would* be called. A deployment
 * wires an HTTP client that forwards to the TrustOS API **with the actor's own credential** —
 * never a service credential, because a gateway that called downstream as itself would be a
 * gateway through which everybody has the gateway's permissions.
 *
 * Two limitations, stated at start-up rather than discovered at the first request: the
 * application catalog is in memory, and no resources are registered until a deployment registers
 * its own.
 */

export interface InternalAppGatewayOptions {
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
export class InternalAppGatewayModule {
  static forRoot(options: InternalAppGatewayOptions): DynamicModule {
    const { config, policy, logger, environment, overrides = {} } = options;

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    return {
      module: InternalAppGatewayModule,
      imports: [DatabaseModule.forRoot({ config, logger })],
      controllers: [GatewayController],
      providers: [
        { provide: APP_CONFIG_TOKEN, useValue: config },
        { provide: APP_LOGGER, useValue: logger },
        { provide: SECURITY_POLICY, useValue: policy },
        { provide: 'GATEWAY_ENVIRONMENT', useValue: environment },

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

        { provide: MASK_POLICY, useValue: overrides.masking ?? new MaskPolicy() },
        { provide: APP_CATALOG, useValue: overrides.apps ?? consoleCatalogFor(environment) },

        {
          provide: GOVERNANCE_AUDIT,
          inject: [AUDIT_SERVICE],
          useFactory: (audit: AuditService) =>
            new GovernanceAuditBridge({ audit, application: config.serviceName, environment }),
        },

        {
          provide: GOVERNANCE_RUNTIME,
          inject: [RESOURCE_REGISTRY, ENVIRONMENT_REGISTRY, GOVERNANCE_AUDIT, MASK_POLICY],
          useFactory: (
            registry: ResourceRegistry,
            environments: EnvironmentRegistry,
            audit: GovernanceAuditBridge,
            masking: MaskPolicy,
          ) => new GovernanceToolRuntime({ registry, environments, audit, masking, environment }),
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
        MASK_POLICY,
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
        'enterprise identity; wire one in InternalAppGatewayModule.forRoot.',
    );
  };

  return {
    name: 'unconfigured',
    findUserByEmail: refuse,
    findUserById: refuse,
    createUser: refuse,
  } as unknown as IdentityProvider;
}
