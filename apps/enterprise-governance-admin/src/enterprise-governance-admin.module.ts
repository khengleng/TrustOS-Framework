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
import { DataCatalog } from '@trustos/data-catalog';
import { LineageGraph } from '@trustos/data-lineage';
import { PolicyRegistry } from '@trustos/policy-registry';
import { InMemoryPolicyDecisionSink, PolicyDecisionLog } from '@trustos/policy-decision-log';
import { PolicyEngine } from '@trustos/policy-engine';
import { ServiceRegistry } from '@trustos/sre-core';
import { ApiCatalog } from '@trustos/api-catalog';
import { ConsumerRegistry } from '@trustos/api-consumer';
import { BackupInventory } from '@trustos/backup';
import { DataGovernanceController } from './controllers/data-governance.controller';
import { PolicyController } from './controllers/policy.controller';
import { ApiGovernanceController } from './controllers/api-governance.controller';
import { ContinuityController, type ContinuityState } from './controllers/continuity.controller';
import {
  ACCESS_RESOLVER,
  API_CATALOG,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  AUDIT_SERVICE,
  AUTHORIZER,
  BACKUP_INVENTORY,
  CONSUMER_REGISTRY,
  CONTINUITY_STATE,
  DATA_CATALOG,
  GUARD_ORDER,
  IDENTITY_PROVIDER,
  LINEAGE_GRAPH,
  POLICY_ENGINE,
  POLICY_REGISTRY,
  SECURITY_EVENTS,
  SECURITY_POLICY,
  SERVICE_REGISTRY,
} from './tokens';

/**
 * Composition root for the Enterprise Governance Console backend.
 *
 * Phase 13's integration proof. Thirty packages across five domains can each pass their own tests
 * and still not compose — a factory whose dependency is not visible from the module that registers
 * it is a start-up failure that only booting finds.
 *
 * The guard order is the security model, and it is the same order as every other TrustOS
 * application, for the same reasons:
 *
 *   AuthenticationGuard           who is calling?
 *   TenantGuard                   whose data may they see?
 *   AuthenticationAssuranceGuard  did they prove it strongly enough?
 *   PermissionsGuard              may they do this at all?      (deny by default)
 *   PolicyAuthorizationGuard      does the full policy set allow it?
 *
 * **Every registry here is in-memory, and that is a stated limitation rather than a design.**
 * Phase 13 adds no Prisma models: a catalog entry, a policy document, a DR plan and a service
 * registration are all documents, and which shape they take in a database is a decision a
 * deployment makes against its own retention and access rules. The registries are constructed
 * from configuration at start-up; the boot log says so, and a deployment supplies loaded state
 * through the overrides below.
 *
 * The one thing that is deliberately *not* in memory is the audit trail. Everything consequential
 * this application does — a reclassification proposal, a policy activation, a DR activation —
 * lands in `@trustos/audit`, which is persistent, because those are the records that matter after
 * a restart and after an incident.
 */

export interface EnterpriseGovernanceAdminOptions {
  config: AppConfig;
  policy: SecurityPolicy;
  logger: Logger;
  overrides?: Partial<{
    identityProvider: IdentityProvider;
    authenticators: CredentialAuthenticator[];
    accessResolver: AccessResolver;
    securityEventSinks: SecurityEventSink[];
    auditService: AuditService;

    dataCatalog: DataCatalog;
    lineage: LineageGraph;
    policyRegistry: PolicyRegistry;
    serviceRegistry: ServiceRegistry;
    apiCatalog: ApiCatalog;
    consumers: ConsumerRegistry;
    backups: BackupInventory;
    continuity: ContinuityState;
    /**
     * Obligation kinds this deployment can honour.
     *
     * Empty by default, which means any policy carrying an obligation is a denial until the
     * deployment declares what it understands. That is the correct default: a caller that
     * silently ignored an unknown obligation would turn a conditional permission into an
     * unconditional one.
     */
    supportedObligations: string[];
  }>;
}

@Global()
@Module({})
export class EnterpriseGovernanceAdminModule {
  static forRoot(options: EnterpriseGovernanceAdminOptions): DynamicModule {
    const { config, policy, logger, overrides = {} } = options;

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    let decisionCounter = 0;

    return {
      module: EnterpriseGovernanceAdminModule,
      imports: [DatabaseModule.forRoot({ config, logger })],
      controllers: [
        DataGovernanceController,
        PolicyController,
        ApiGovernanceController,
        ContinuityController,
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
             * be a template for granting governance access from a token claim, and governance
             * access is the access that lets somebody change what everything else is allowed to do.
             */
            ({ resolve: async () => null } satisfies AccessResolver),
        },

        // --- the enterprise layer --------------------------------------------
        { provide: DATA_CATALOG, useValue: overrides.dataCatalog ?? new DataCatalog() },
        { provide: LINEAGE_GRAPH, useValue: overrides.lineage ?? new LineageGraph() },
        { provide: POLICY_REGISTRY, useValue: overrides.policyRegistry ?? new PolicyRegistry() },
        { provide: SERVICE_REGISTRY, useValue: overrides.serviceRegistry ?? new ServiceRegistry() },
        { provide: API_CATALOG, useValue: overrides.apiCatalog ?? new ApiCatalog() },
        { provide: CONSUMER_REGISTRY, useValue: overrides.consumers ?? new ConsumerRegistry() },
        { provide: BACKUP_INVENTORY, useValue: overrides.backups ?? new BackupInventory() },
        {
          provide: CONTINUITY_STATE,
          useValue:
            overrides.continuity ??
            ({ processes: [], drPlans: [], restoreTests: [] } as ContinuityState),
        },

        {
          provide: POLICY_ENGINE,
          inject: [POLICY_REGISTRY],
          useFactory: (registry: PolicyRegistry) =>
            new PolicyEngine({
              registry,
              /*
               * The decision log sink is in memory here, which is the limitation worth naming
               * loudest in this file: a decision log that does not survive a restart cannot
               * answer an auditor. A deployment binds a persistent sink.
               */
              log: new PolicyDecisionLog(new InMemoryPolicyDecisionSink()),
              supportedObligations: overrides.supportedObligations ?? [],
              newDecisionId: () => `dec_${(decisionCounter += 1)}`,
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
        DATA_CATALOG,
        LINEAGE_GRAPH,
        POLICY_REGISTRY,
        POLICY_ENGINE,
        SERVICE_REGISTRY,
        API_CATALOG,
        CONSUMER_REGISTRY,
        BACKUP_INVENTORY,
        CONTINUITY_STATE,
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
      'No identity provider is configured. This application authenticates against the deployment ' +
        'it governs; wire one in EnterpriseGovernanceAdminModule.forRoot.',
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
