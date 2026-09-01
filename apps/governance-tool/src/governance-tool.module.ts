import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuditService, PrismaAuditSink } from '@trustsystem/audit';
import { Authorizer, createAuthorizer, roleGrantPolicy } from '@trustsystem/authorization';
import { PolicyAuthorizationGuard } from '@trustsystem/authorization/nest';
import type { AppConfig } from '@trustsystem/config';
import { PrismaAccessResolver } from '@trustsystem/access-resolver';
import { DatabaseModule, PrismaService, checkDatabaseConnection } from '@trustsystem/database';
import {
  ObservabilityModule,
  databaseHealthIndicator,
  identityHealthIndicator,
} from '@trustsystem/observability';
import { BearerTokenAuthenticator } from '@trustsystem/identity';
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
  InternalAppCatalog,
  consoleCatalogFor,
  type Environment,
  NO_APPLICATION_EVIDENCE,
  type ApplicationEvidenceIndex,
} from '@trustsystem/governance-tool-core';
import { GovernanceAuditBridge } from '@trustsystem/governance-audit-bridge';
import {
  EnvironmentRegistry,
  environmentConfigSchema,
} from '@trustsystem/governance-environment-config';
import { MaskPolicy } from '@trustsystem/governance-pii-policy';
import { ResourceRegistry } from '@trustsystem/governance-resource-policy';
import { GovernanceToolRuntime } from '@trustsystem/governance-tool-runtime';
import type { ApprovalWorkbenchService } from '@trustsystem/approval-workbench';
import { ApprovalWorkbenchController } from './controllers/approval-workbench.controller';
import { CatalogController } from './controllers/catalog.controller';
import { ConsoleController } from './controllers/console.controller';
import { PortalController, type PortalConfig } from './controllers/portal.controller';
import {
  ACCESS_RESOLVER,
  APP_CATALOG,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  AUDIT_SERVICE,
  AUTHORIZER,
  ENVIRONMENT_REGISTRY,
  APPLICATION_EVIDENCE,
  APPROVAL_WORKBENCH,
  GATEWAY_ENVIRONMENT,
  GOVERNANCE_AUDIT,
  GOVERNANCE_RUNTIME,
  GUARD_ORDER,
  IDENTITY_PROVIDER,
  PORTAL_CONFIG,
  RESOURCE_REGISTRY,
  SECURITY_EVENTS,
  SECURITY_POLICY,
} from './tokens';
import { PersistentAppCatalog } from './persistent-app-catalog';

/**
 * The Governance Tool.
 *
 * The catalog of internal applications, the console templates, the resource registry behind them
 * and the promotion that moves an application between environments.
 *
 * **This application serves descriptors. It carries no traffic.** Reads and actions go through
 * `@trustsystem/internal-app-gateway`, which is a separate deployable for a reason: the surface that
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
    /** What the browser needs to begin a login. Null when this runs without OIDC. */
    portal: PortalConfig;
    /**
     * The Approval Workbench.
     *
     * Absent unless a deployment wires the workflow stores. Its routes then answer
     * "not configured" rather than returning empty pages that read as "no approvals".
     */
    approvalWorkbench: ApprovalWorkbenchService;
    /** Validation evidence per application. Absent means every application is `not_tested`. */
    applicationEvidence: ApplicationEvidenceIndex;
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
            indicators: [
              databaseHealthIndicator(() => checkDatabaseConnection(prisma)),
              /*
               * Identity, when there is one to report on.
               *
               * A service running OIDC that cannot reach its provider's keys will refuse
               * every authenticated request, and readiness is the signal that should say
               * so rather than leaving the instance in rotation to fail one caller at a
               * time. Reported from what token validation has already observed — no probe
               * request, because a readiness check that calls the identity provider on
               * every poll is a way to be rate-limited by it.
               *
               * Omitted entirely when no provider is configured: an indicator that
               * reports "ok" for an absent provider would be worse than none.
               */
              ...(overrides.identityProvider
                ? [identityHealthIndicator(() => overrides.identityProvider!.health())]
                : []),
            ],
          })) as never,
        }),
      ],
      controllers: [
        ApprovalWorkbenchController,
        CatalogController,
        ConsoleController,
        PortalController,
      ],
      providers: [
        { provide: APP_CONFIG_TOKEN, useValue: config },
        { provide: APP_LOGGER, useValue: logger },
        { provide: SECURITY_POLICY, useValue: policy },
        { provide: GATEWAY_ENVIRONMENT, useValue: environment },

        /*
         * The Approval Workbench, when a deployment wires it.
         *
         * Provided as null rather than omitted so the controller's optional injection
         * resolves either way, and so the "not configured" answer comes from one place
         * instead of from a missing-provider crash.
         */
        { provide: APPROVAL_WORKBENCH, useValue: overrides.approvalWorkbench ?? null },
        {
          provide: APPLICATION_EVIDENCE,
          useValue: overrides.applicationEvidence ?? NO_APPLICATION_EVIDENCE,
        },

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

        { provide: PORTAL_CONFIG, useValue: overrides.portal ?? null },

        {
          provide: IDENTITY_PROVIDER,
          useValue: overrides.identityProvider ?? refusingIdentityProvider(),
        },

        /*
         * Membership, resolved from the database rather than trusted from the token.
         *
         * The default was a resolver that returned null for everything. It was honest
         * about provisioning nothing, and its effect was that every subject below
         * platform-root authenticated and was then refused: roles existed, memberships
         * existed, and nothing joined them.
         *
         * A factory rather than a value, because it needs the Prisma client the module
         * already owns — building it in `main.ts` would mean a second connection pool
         * for one query.
         */
        {
          provide: ACCESS_RESOLVER,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService): AccessResolver =>
            overrides.accessResolver ?? new PrismaAccessResolver({ prisma }),
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

        {
          provide: APP_CATALOG,
          inject: [PrismaService],
          /*
           * Durable, and seeded from the console templates on a genuinely empty environment.
           *
           * The previous default was an in-memory catalog, which meant every application
           * registered through the API existed until the container next moved. That is a
           * governance record disappearing on a restart. `PersistentAppCatalog` keeps the reads
           * in memory — the registration check is on every request's path — while making the
           * table the record of what exists.
           */
          useFactory: async (prisma: PrismaService): Promise<InternalAppCatalog> =>
            overrides.apps ??
            (await PersistentAppCatalog.load({
              prisma,
              environment,
              seed: consoleCatalogFor(environment).list(environment),
              logger,
            })),
        },

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
          /*
           * The bearer authenticator is assembled here, from the identity provider and
           * the resolver this module already holds.
           *
           * It used to be built in `main.ts` and passed in, which meant the caller had to
           * supply an access resolver too — and the one it supplied was the null stub.
           * Wiring it here is what lets the real resolver reach the guard: configuration
           * stays in main.ts, and what is connected to what stays in the module.
           */
          useFactory: (
            reflector: Reflector,
            identityProvider: IdentityProvider,
            accessResolver: AccessResolver,
            events: SecurityEventEmitter,
          ) =>
            new AuthenticationGuard(
              reflector,
              overrides.authenticators ??
                (identityProvider.kind === 'oidc'
                  ? [
                      new BearerTokenAuthenticator({
                        provider: identityProvider,
                        access: accessResolver,
                        events,
                      }),
                    ]
                  : []),
              {},
            ),
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
