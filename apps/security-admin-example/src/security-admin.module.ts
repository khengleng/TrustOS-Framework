import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ApiKeyAuthenticator, ApiKeyService, PrismaApiKeyStore } from '@trustsystem/api-keys';
import { ScopeGuard } from '@trustsystem/api-keys/nest';
import { AuditService, PrismaAuditSink } from '@trustsystem/audit';
import { TokenService } from '@trustsystem/auth';
import { Authorizer, createAuthorizer, roleGrantPolicy } from '@trustsystem/authorization';
import { PolicyAuthorizationGuard } from '@trustsystem/authorization/nest';
import type { AppConfig } from '@trustsystem/config';
import { DatabaseModule, PrismaService } from '@trustsystem/database';
import {
  BearerTokenAuthenticator,
  LocalIdentityProvider,
  LockoutTracker,
  InMemoryLockoutStore,
  OidcIdentityProvider,
  WellKnownPasswordChecker,
  createPasswordHasher,
  type AccessResolver,
  type CredentialAuthenticator,
  type IdentityProvider,
  type LocalAccessResolver,
  type LocalTokenPort,
  type LocalUserPort,
} from '@trustsystem/identity';
import { AuthenticationAssuranceGuard, AuthenticationGuard } from '@trustsystem/identity/nest';
import type { Logger } from '@trustsystem/logging';
import { canGrantRole } from '@trustsystem/rbac';
import { PermissionsGuard } from '@trustsystem/rbac';
import {
  InMemorySecurityEventSink,
  LoggerSecurityEventSink,
  PersistentSecurityEventSink,
  SecurityEventEmitter,
  type SecurityEventSink,
} from '@trustsystem/security-events';
import type { SecurityPolicy } from '@trustsystem/security-policy';
import {
  PrismaServiceAccountStore,
  ServiceAccountAuthenticator,
  ServiceAccountService,
} from '@trustsystem/service-accounts';
import { InteractiveRouteGuard } from '@trustsystem/service-accounts/nest';
import { SessionService } from '@trustsystem/session-security';
import { TenantGuard } from '@trustsystem/tenancy';
import { ApiKeyController } from './controllers/api-key.controller';
import { IdentityController } from './controllers/identity.controller';
import { SecurityEventController } from './controllers/security-event.controller';
import { ServiceAccountController } from './controllers/service-account.controller';
import { SessionController } from './controllers/session.controller';
import { PrismaLocalUserStore } from './core/prisma-local-user-store';
import { PrismaSessionStore } from './core/prisma-session-store';
import {
  ACCESS_RESOLVER,
  API_KEY_SERVICE,
  AUDIT_SERVICE,
  AUTHORIZER,
  GUARD_ORDER,
  IDENTITY_PROVIDER,
  SECURITY_EVENTS,
  SECURITY_POLICY,
  SERVICE_ACCOUNT_SERVICE,
  SESSION_SERVICE,
  APP_LOGGER,
  APP_CONFIG_TOKEN,
} from './tokens';

/**
 * Composition root for the security administration API.
 *
 * This is the phase's integration proof as much as it is an example: every package
 * added in phase 4 is wired here, against the real framework, and
 * `security-admin.spec.ts` boots it and asserts the guards resolve and the routes
 * map.
 *
 * The guard order is the security model, and it is longer than phase 1's because
 * there are more questions to answer. Nest applies `APP_GUARD` providers in
 * registration order, so this array *is* the order:
 *
 *   AuthenticationGuard           who is calling?              -> request.actor
 *   TenantGuard                   whose data may they see?     -> request.organizationId
 *   InteractiveRouteGuard         is this route for a person?
 *   AuthenticationAssuranceGuard  did they prove it strongly enough?
 *   PermissionsGuard              may they do this at all?     (deny by default)
 *   ScopeGuard                    may this credential do it?
 *   PolicyAuthorizationGuard      does the full policy set allow it?
 *
 * Each one can only refuse. Reordering them is a security review, not a refactor —
 * in particular, assurance has to run before permissions so that a privileged role
 * with no second factor is stopped before its permissions are consulted.
 */

export interface SecurityAdminOptions {
  config: AppConfig;
  policy: SecurityPolicy;
  logger: Logger;
  /** Provider-specific settings, when the OIDC provider is selected. */
  oidc?: {
    issuerUrl: string;
    clientId: string;
    roleMap?: Record<string, string>;
    superAdminRoles?: string[];
    organizationClaim?: string;
    endSessionEndpoint?: string;
  };
  /** Salt for correlation hashes. Read from configuration; never logged. */
  correlationSalt: string;
  /** Overridden by the boot test, so it needs no database. */
  overrides?: Partial<{
    identityProvider: IdentityProvider;
    authenticators: CredentialAuthenticator[];
    accessResolver: AccessResolver;
    securityEventSinks: SecurityEventSink[];
    sessionService: SessionService;
    apiKeyService: ApiKeyService;
    serviceAccountService: ServiceAccountService;
    auditService: AuditService;
  }>;
}

@Global()
@Module({})
export class SecurityAdminModule {
  static forRoot(options: SecurityAdminOptions): DynamicModule {
    const { config, policy, logger, overrides = {} } = options;

    const memoryEvents = new InMemorySecurityEventSink();

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    return {
      module: SecurityAdminModule,
      /*
       * Imported rather than assumed. Every factory below injects `PrismaService`,
       * and a module that exports a provider it does not own fails at start-up with a
       * message about the export instead of the missing import — the kind of error
       * that costs an afternoon and that this app's boot test now catches.
       */
      imports: [DatabaseModule.forRoot({ config, logger })],
      controllers: [
        IdentityController,
        SessionController,
        ApiKeyController,
        ServiceAccountController,
        SecurityEventController,
      ],
      providers: [
        { provide: APP_CONFIG_TOKEN, useValue: config },
        { provide: APP_LOGGER, useValue: logger },
        { provide: SECURITY_POLICY, useValue: policy },
        // Exposed so the events controller can render the recent list without a
        // database. A deployment reads the persistent table instead.
        { provide: 'SECURITY_EVENT_MEMORY', useValue: memoryEvents },

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
                memoryEvents,
                new LoggerSecurityEventSink(logger),
                // The table is platform-owned; reading it needs `platform.admin`.
                new PersistentSecurityEventSink(prisma.securityEvent),
              ],
            }),
        },

        {
          provide: IDENTITY_PROVIDER,
          inject: [SECURITY_EVENTS, PrismaService, ACCESS_RESOLVER],
          useFactory: (
            events: SecurityEventEmitter,
            prisma: PrismaService,
            access: AccessResolver,
          ): IdentityProvider =>
            overrides.identityProvider ??
            buildIdentityProvider({
              policy,
              options,
              events,
              logger,
              users: new PrismaLocalUserStore(prisma),
              tokens: new TokenService(config),
              access,
            }),
        },

        {
          provide: ACCESS_RESOLVER,
          useValue:
            overrides.accessResolver ??
            /*
             * The default resolver refuses everything, and that is deliberate: an
             * example application that shipped a permissive resolver would be a
             * template for granting access from a token claim. A deployment supplies
             * one backed by its membership tables.
             */
            ({
              resolve: async () => null,
            } satisfies AccessResolver),
        },

        {
          provide: SESSION_SERVICE,
          inject: [SECURITY_EVENTS, PrismaService],
          useFactory: (events: SecurityEventEmitter, prisma: PrismaService) =>
            overrides.sessionService ??
            new SessionService({
              store: new PrismaSessionStore(prisma),
              policy: policy.sessions,
              events,
              correlationSalt: options.correlationSalt,
            }),
        },

        {
          provide: API_KEY_SERVICE,
          inject: [SECURITY_EVENTS, PrismaService],
          useFactory: (events: SecurityEventEmitter, prisma: PrismaService) =>
            overrides.apiKeyService ??
            new ApiKeyService({
              store: new PrismaApiKeyStore(prisma.apiKey),
              policy: policy.apiKeys,
              events,
              environment: config.env,
            }),
        },

        {
          provide: SERVICE_ACCOUNT_SERVICE,
          inject: [SECURITY_EVENTS, PrismaService],
          useFactory: (events: SecurityEventEmitter, prisma: PrismaService) =>
            overrides.serviceAccountService ??
            new ServiceAccountService({
              store: new PrismaServiceAccountStore(prisma.serviceAccount),
              policy: policy.apiKeys,
              events,
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
              // Role escalation is one of the five named attacks; the framework's own
              // grant matrix is the check.
              additional: [roleGrantPolicy(canGrantRole)],
            }),
        },

        /*
         * --- guards, in order ------------------------------------------------
         *
         * Each entry is wrapped in `orderedGuard`, which records the class name as the
         * provider is constructed. The recorded list is published as `GUARD_ORDER` and
         * is therefore the registration order itself rather than a copy of it — the
         * boot test asserts on it, and a reordering cannot pass silently.
         */
        orderedGuard(AuthenticationGuard, {
          provide: APP_GUARD,
          inject: [
            Reflector,
            IDENTITY_PROVIDER,
            ACCESS_RESOLVER,
            SECURITY_EVENTS,
            API_KEY_SERVICE,
            SERVICE_ACCOUNT_SERVICE,
          ],
          useFactory: (
            reflector: Reflector,
            provider: IdentityProvider,
            access: AccessResolver,
            events: SecurityEventEmitter,
            apiKeys: ApiKeyService,
            serviceAccounts: ServiceAccountService,
          ) =>
            new AuthenticationGuard(
              reflector,
              overrides.authenticators ?? [
                new BearerTokenAuthenticator({ provider, access, events }),
                new ApiKeyAuthenticator({
                  service: apiKeys,
                  resolveAccess: async (organizationId) =>
                    access.resolve(organizationId, organizationId),
                  events,
                }),
                new ServiceAccountAuthenticator({
                  service: serviceAccounts,
                  resolveAccess: async (organizationId) =>
                    organizationId ? access.resolve(organizationId, organizationId) : null,
                }),
              ],
              { events },
            ),
        }),

        orderedGuard(TenantGuard, { provide: APP_GUARD, useClass: TenantGuard }),

        orderedGuard(InteractiveRouteGuard, {
          provide: APP_GUARD,
          inject: [Reflector, SECURITY_EVENTS],
          useFactory: (reflector: Reflector, events: SecurityEventEmitter) =>
            new InteractiveRouteGuard(reflector, { events }),
        }),

        orderedGuard(AuthenticationAssuranceGuard, {
          provide: APP_GUARD,
          inject: [Reflector, SECURITY_EVENTS],
          useFactory: (reflector: Reflector, events: SecurityEventEmitter) =>
            new AuthenticationAssuranceGuard(reflector, policy.mfa, { events }),
        }),

        orderedGuard(PermissionsGuard, { provide: APP_GUARD, useClass: PermissionsGuard }),

        orderedGuard(ScopeGuard, {
          provide: APP_GUARD,
          inject: [Reflector, SECURITY_EVENTS],
          useFactory: (reflector: Reflector, events: SecurityEventEmitter) =>
            new ScopeGuard(reflector, { events }),
        }),

        orderedGuard(PolicyAuthorizationGuard, {
          provide: APP_GUARD,
          inject: [Reflector, AUTHORIZER],
          useFactory: (reflector: Reflector, authorizer: Authorizer) =>
            new PolicyAuthorizationGuard(reflector, authorizer),
        }),

        // Populated by the wrappers above, which have all run by the time this element
        // of the array literal is evaluated.
        { provide: GUARD_ORDER, useFactory: () => [...guardOrder] },
      ],
      exports: [
        APP_CONFIG_TOKEN,
        APP_LOGGER,
        SECURITY_POLICY,
        SECURITY_EVENTS,
        IDENTITY_PROVIDER,
        SESSION_SERVICE,
        API_KEY_SERVICE,
        SERVICE_ACCOUNT_SERVICE,
        AUTHORIZER,
        AUDIT_SERVICE,
        'SECURITY_EVENT_MEMORY',
        GUARD_ORDER,
        /*
         * The module, not the provider. `PrismaService` belongs to `DatabaseModule`,
         * and Nest refuses to export a provider a module does not own — re-exporting
         * the module is how an importer of this one still gets it. A provider declared
         * but not exported is invisible to every importing module, which is a start-up
         * failure only a boot test finds.
         */
        DatabaseModule,
      ],
    };
  }
}

/**
 * Builds the configured provider.
 *
 * Exactly one. The policy refuses `local` alongside `oidc` in production, and this
 * is where that refusal becomes a single object: two providers that could both
 * authenticate one request would mean the weaker one decides.
 */
function buildIdentityProvider(input: {
  policy: SecurityPolicy;
  options: SecurityAdminOptions;
  events: SecurityEventEmitter;
  logger: Logger;
  users: LocalUserPort;
  tokens: LocalTokenPort;
  access: LocalAccessResolver;
}): IdentityProvider {
  const { policy, options } = input;

  if (policy.allowedIdentityProviders.includes('oidc')) {
    if (!options.oidc) {
      throw new Error('IDENTITY_PROVIDER=oidc requires OIDC_ISSUER_URL and OIDC_CLIENT_ID.');
    }

    return new OidcIdentityProvider(
      {
        issuerUrl: options.oidc.issuerUrl,
        clientId: options.oidc.clientId,
        ...(options.oidc.roleMap ? { roleMap: options.oidc.roleMap } : {}),
        ...(options.oidc.superAdminRoles ? { superAdminRoles: options.oidc.superAdminRoles } : {}),
        ...(options.oidc.organizationClaim
          ? { organizationClaim: options.oidc.organizationClaim }
          : {}),
        ...(options.oidc.endSessionEndpoint
          ? { endSessionEndpoint: options.oidc.endSessionEndpoint }
          : {}),
      },
      policy.tokens,
      policy.mfa,
    );
  }

  /*
   * The local provider. Real, not a stub: `IDENTITY_PROVIDER=local` has to boot and
   * authenticate, or the two supported modes are one supported mode and a promise.
   *
   * `access` is the resolver, and it is the single most important line in this
   * function: roles and permissions are looked up from the membership tables *here*,
   * on the server, per login. Nothing is read from a submitted claim. A provider that
   * took roles from its input would make every one of the guards downstream
   * decorative.
   */
  return new LocalIdentityProvider({
    users: input.users,
    tokens: input.tokens,
    hasher: createPasswordHasher({ forTests: policy.environment === 'test' }),
    /*
     * In-memory, and stated rather than hidden: the counter is per process, so N
     * instances behind a load balancer give an attacker N times the attempts. That is
     * a real limitation, it is documented in docs/enterprise-identity.md, and the
     * `LockoutStore` port is the extension point — a shared store is a one-class
     * change. This phase adds no Redis.
     */
    lockout: new LockoutTracker(new InMemoryLockoutStore(), policy.lockout),
    access: input.access,
    // The default checker holds a small list of the passwords that appear in every
    // breach corpus. The port is the extension point for a real corpus or an external
    // service; `docs/enterprise-identity.md` documents the interface, and this phase
    // deliberately integrates neither.
    compromisedPasswords: new WellKnownPasswordChecker(),
    events: input.events,
    tokenPolicy: policy.tokens,
    passwordPolicy: policy.passwords,
    mfaPolicy: policy.mfa,
    correlationSalt: input.options.correlationSalt,
  });
}
