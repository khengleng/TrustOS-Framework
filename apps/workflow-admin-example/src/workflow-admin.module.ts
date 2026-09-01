import { DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuditService, PrismaAuditSink } from '@trustsystem/audit';
import { Authorizer, createAuthorizer, roleGrantPolicy } from '@trustsystem/authorization';
import { PolicyAuthorizationGuard } from '@trustsystem/authorization/nest';
import { CaseService, PrismaCaseStore } from '@trustsystem/case-management';
import type { AppConfig } from '@trustsystem/config';
import { DatabaseModule, PrismaService } from '@trustsystem/database';
import { AuthenticationAssuranceGuard, AuthenticationGuard } from '@trustsystem/identity/nest';
import type {
  AccessResolver,
  CredentialAuthenticator,
  IdentityProvider,
} from '@trustsystem/identity';
import type { Logger } from '@trustsystem/logging';
import { InMemoryMetricsRecorder, type MetricsRecorder } from '@trustsystem/observability';
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
  AttachmentService,
  CommentService,
  HistoryRecorder,
  PrismaAttachmentStore,
  PrismaCommentStore,
  PrismaHistoryStore,
  type DocumentPort,
} from '@trustsystem/workflow-history';
import { WORKFLOW_POLICIES } from '@trustsystem/workflow-policy';
import { CalendarRegistry, SlaService } from '@trustsystem/workflow-sla';
import { EscalationService, LoggingEscalationNotifier } from '@trustsystem/workflow-escalation';
import { PrismaTaskStore, TaskService, type MemberDirectory } from '@trustsystem/workflow-tasks';
import {
  CompiledWorkflowCache,
  PrismaDecisionStore,
  PrismaDefinitionStore,
  PrismaIdempotencyStore,
  PrismaInstanceStore,
  PrismaRoundRobinCursor,
  PrismaSlaStore,
  PrismaEscalationStore,
  PrismaVersionStore,
  WorkflowDefinitionService,
  WorkflowEngine,
  type BusinessObjectValidator,
} from '@trustsystem/workflow-runtime';
import { ALL_WORKFLOW_PERMISSION_KEYS } from '@trustsystem/workflow-core';
import { ALL_PERMISSION_KEYS } from '@trustsystem/rbac';
import { CaseController } from './controllers/case.controller';
import { DefinitionController } from './controllers/definition.controller';
import { InstanceController } from './controllers/instance.controller';
import { OperationsController } from './controllers/operations.controller';
import { TaskController } from './controllers/task.controller';
import { PrismaMemberDirectory } from './core/prisma-member-directory';
import {
  ACCESS_RESOLVER,
  APP_CONFIG_TOKEN,
  APP_LOGGER,
  ATTACHMENT_SERVICE,
  AUDIT_SERVICE,
  AUTHORIZER,
  CASE_SERVICE,
  COMMENT_SERVICE,
  ESCALATION_SERVICE,
  GUARD_ORDER,
  HISTORY_RECORDER,
  IDENTITY_PROVIDER,
  MEMBER_DIRECTORY,
  SECURITY_EVENTS,
  SECURITY_POLICY,
  SLA_SERVICE,
  TASK_SERVICE,
  WORKFLOW_DEFINITION_SERVICE,
  WORKFLOW_ENGINE,
} from './tokens';

/**
 * Composition root for the workflow administration API.
 *
 * This is the phase's integration proof as much as it is an example: all ten packages
 * added in phase 5 are wired here against the real framework, and `workflow-admin.spec.ts`
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
 * Each one can only refuse. `PolicyAuthorizationGuard` is last because it is the only one
 * with the full picture — and it is where the workflow policies live, so separation of duty
 * is checked after identity, tenancy and permissions are settled.
 *
 * The workflow policies are added to the authorizer rather than checked in the engine. The
 * engine calls `authorizer.assert` with the loaded record, because a guard runs before the
 * handler has loaded anything — see `docs/workflow-security.md`.
 */

export interface WorkflowAdminOptions {
  config: AppConfig;
  policy: SecurityPolicy;
  logger: Logger;
  metrics?: MetricsRecorder;
  /**
   * Business-object validators.
   *
   * One per object type an application's workflows govern. Without one, an instance could
   * be started against a record in another organization — so the engine refuses rather than
   * accepting any `objectType`/`objectId` pair. See `WorkflowEngineOptions`.
   */
  objectValidators?: BusinessObjectValidator[];
  /** The document module, when it is installed. Absent means no evidence can be attached. */
  documents?: DocumentPort;
  /** Overridden by the boot test, so it needs no database. */
  overrides?: Partial<{
    identityProvider: IdentityProvider;
    authenticators: CredentialAuthenticator[];
    accessResolver: AccessResolver;
    securityEventSinks: SecurityEventSink[];
    auditService: AuditService;
    memberDirectory: MemberDirectory;
    documents: DocumentPort;
  }>;
}

@Global()
@Module({})
export class WorkflowAdminModule {
  static forRoot(options: WorkflowAdminOptions): DynamicModule {
    const { config, policy, logger, overrides = {} } = options;
    const metrics = options.metrics ?? new InMemoryMetricsRecorder();

    const guardOrder: string[] = [];
    const orderedGuard = <T extends Provider>(guard: { name: string }, provider: T): T => {
      guardOrder.push(guard.name);
      return provider;
    };

    return {
      module: WorkflowAdminModule,
      /*
       * `DatabaseModule` is imported rather than assumed. Every factory below injects
       * `PrismaService`, and a module that exports a provider it does not own fails at
       * start-up with a message about the export rather than the missing import — the kind
       * of error that costs an afternoon and that the boot test now catches.
       */
      imports: [DatabaseModule.forRoot({ config, logger })],
      controllers: [
        DefinitionController,
        InstanceController,
        TaskController,
        OperationsController,
        CaseController,
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
               * The workflow policies, on top of the framework's standard set.
               *
               * Every one of them can only *refuse* — none returns `allow` — so adding them
               * can only make the system stricter. `roleGrantPolicy` is the phase 4
               * escalation check, kept because a workflow that assigns roles would
               * otherwise bypass it.
               */
              additional: [...WORKFLOW_POLICIES, roleGrantPolicy(canGrantRole)],
            }),
        },

        {
          provide: IDENTITY_PROVIDER,
          useValue:
            overrides.identityProvider ??
            /*
             * No provider by default, deliberately.
             *
             * This application is an administration surface over an existing deployment's
             * workflows, so it authenticates against whatever that deployment uses. A
             * default local provider here would be a second, weaker way in.
             */
            refusingIdentityProvider(),
        },

        {
          provide: ACCESS_RESOLVER,
          useValue:
            overrides.accessResolver ??
            /*
             * The default resolver refuses everything, and that is deliberate: an example
             * that shipped a permissive resolver would be a template for granting access
             * from a token claim. A deployment supplies one backed by its membership tables.
             */
            ({ resolve: async () => null } satisfies AccessResolver),
        },

        {
          provide: MEMBER_DIRECTORY,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService): MemberDirectory =>
            overrides.memberDirectory ?? new PrismaMemberDirectory(prisma),
        },

        // --- workflow --------------------------------------------------------
        {
          provide: HISTORY_RECORDER,
          inject: [PrismaService, AUDIT_SERVICE],
          useFactory: (prisma: PrismaService, audit: AuditService) =>
            new HistoryRecorder({
              store: new PrismaHistoryStore(prisma.workflowEvent),
              // Both trails, written by one call, so a caller cannot write one and forget
              // the other.
              audit,
            }),
        },

        {
          provide: TASK_SERVICE,
          inject: [PrismaService, SECURITY_EVENTS, HISTORY_RECORDER],
          useFactory: (
            prisma: PrismaService,
            events: SecurityEventEmitter,
            history: HistoryRecorder,
          ) =>
            new TaskService({
              store: new PrismaTaskStore(prisma.workflowTask),
              events,
              recorder: {
                record: async (input) =>
                  void (await history.record({
                    type: input.type,
                    organizationId: input.task.organizationId,
                    workflowInstanceId: input.task.workflowInstanceId,
                    workflowTaskId: input.task.id,
                    actorId: input.actorId,
                    metadata: { stepKey: input.task.stepKey, ...input.metadata },
                  })),
              },
            }),
        },

        {
          provide: SLA_SERVICE,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) =>
            new SlaService({
              store: new PrismaSlaStore(prisma.workflowSla),
              // Elapsed time only in this phase. A working-hours calendar registers here;
              // `validateDefinition` refuses a definition naming an unregistered one, so a
              // missing registration fails at publication rather than becoming a silently
              // wrong SLA.
              calendars: new CalendarRegistry(),
            }),
        },

        {
          provide: ESCALATION_SERVICE,
          inject: [PrismaService, SECURITY_EVENTS],
          useFactory: (prisma: PrismaService, events: SecurityEventEmitter) =>
            new EscalationService({
              store: new PrismaEscalationStore(prisma.workflowEscalation),
              // A logging notifier by default. The notification module satisfies the same
              // interface; a workflow engine that could not escalate without it would be
              // unusable in most deployments.
              notifier: new LoggingEscalationNotifier(logger),
              events,
            }),
        },

        {
          provide: COMMENT_SERVICE,
          inject: [PrismaService, HISTORY_RECORDER],
          useFactory: (prisma: PrismaService, history: HistoryRecorder) =>
            new CommentService({
              store: new PrismaCommentStore(
                prisma.workflowComment,
                prisma.workflowCommentAmendment,
                // A transaction runner is required, not optional: amending writes two rows
                // and either half alone is worse than neither.
                { transaction: (fn) => prisma.$transaction(fn as never) as never },
              ),
              onRecorded: async (notice) =>
                void (await history.record({
                  type: notice.type,
                  organizationId: notice.organizationId,
                  workflowInstanceId: notice.workflowInstanceId,
                  caseId: notice.caseId,
                  workflowTaskId: notice.workflowTaskId,
                  actorId: notice.actorId,
                  metadata: { commentId: notice.commentId, ...notice.metadata },
                })),
            }),
        },

        {
          provide: ATTACHMENT_SERVICE,
          inject: [PrismaService, HISTORY_RECORDER],
          useFactory: (prisma: PrismaService, history: HistoryRecorder) =>
            new AttachmentService({
              store: new PrismaAttachmentStore(prisma.workflowAttachment),
              documents: overrides.documents ?? options.documents ?? refusingDocumentPort(),
              onRecorded: async (notice) =>
                void (await history.record({
                  type: notice.type,
                  organizationId: notice.organizationId,
                  workflowInstanceId: notice.workflowInstanceId,
                  caseId: notice.caseId,
                  workflowTaskId: notice.workflowTaskId,
                  actorId: notice.actorId,
                  metadata: { attachmentId: notice.attachmentId, ...notice.metadata },
                })),
            }),
        },

        {
          provide: WORKFLOW_ENGINE,
          inject: [
            PrismaService,
            AUTHORIZER,
            HISTORY_RECORDER,
            TASK_SERVICE,
            SLA_SERVICE,
            SECURITY_EVENTS,
            MEMBER_DIRECTORY,
            ATTACHMENT_SERVICE,
          ],
          useFactory: (
            prisma: PrismaService,
            authorizer: Authorizer,
            history: HistoryRecorder,
            tasks: TaskService,
            sla: SlaService,
            events: SecurityEventEmitter,
            directory: MemberDirectory,
            attachments: AttachmentService,
          ) =>
            new WorkflowEngine({
              instances: new PrismaInstanceStore(prisma.workflowInstance),
              versions: new PrismaVersionStore(
                prisma.workflowVersion,
                prisma.workflowInstance,
                prisma.workflowDefinition,
              ),
              decisions: new PrismaDecisionStore(prisma.workflowDecision),
              tasks,
              taskStore: new PrismaTaskStore(prisma.workflowTask),
              history,
              authorizer,
              sla,
              idempotency: new PrismaIdempotencyStore(prisma.workflowIdempotencyRecord),
              assignment: {
                directory,
                // Persisted, because a counter that resets on every deploy sends every task
                // after a restart to the same person.
                cursor: new PrismaRoundRobinCursor(prisma.workflowAssignmentCursor),
              },
              events,
              metrics,
              objectValidators: options.objectValidators ?? [],
              hasAttachment: (input) => attachments.hasRequiredAttachment(input),
              // Cacheable precisely because a published version is immutable: there is no
              // invalidation to get wrong.
              cache: new CompiledWorkflowCache(),
              /*
               * Development only. In production a missing validator is a refusal, because
               * without one an instance could be started against another organization's
               * record — see `WorkflowEngineOptions.allowUnvalidatedBusinessObjects`.
               */
              ...(config.env !== 'production' ? { allowUnvalidatedBusinessObjects: true } : {}),
            }),
        },

        {
          provide: WORKFLOW_DEFINITION_SERVICE,
          inject: [PrismaService, AUTHORIZER, HISTORY_RECORDER],
          useFactory: (prisma: PrismaService, authorizer: Authorizer, history: HistoryRecorder) =>
            new WorkflowDefinitionService({
              definitions: new PrismaDefinitionStore(prisma.workflowDefinition),
              versions: new PrismaVersionStore(
                prisma.workflowVersion,
                prisma.workflowInstance,
                prisma.workflowDefinition,
              ),
              history,
              authorizer,
              // The catalog, so a definition referencing a misspelled permission is refused
              // at publication rather than becoming a step nobody can ever act on.
              knownPermissions: [...ALL_PERMISSION_KEYS, ...ALL_WORKFLOW_PERMISSION_KEYS],
              registeredResolvers: [],
              registeredCallbacks: [],
              registeredCalendars: ['elapsed'],
            }),
        },

        {
          provide: CASE_SERVICE,
          inject: [PrismaService, HISTORY_RECORDER],
          useFactory: (prisma: PrismaService, history: HistoryRecorder) =>
            new CaseService({
              store: new PrismaCaseStore(prisma.caseRecord, prisma.workflowInstance),
              history,
            }),
        },

        // --- guards, in order ------------------------------------------------
        //
        // Each entry is wrapped in `orderedGuard`, which records the class name as the
        // provider is constructed. The recorded list is published as `GUARD_ORDER`, so the
        // boot test asserts on the registration order itself rather than on a restatement
        // of it.
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

        // Populated by the wrappers above, which have all run by the time this element of
        // the array literal is evaluated.
        { provide: GUARD_ORDER, useFactory: () => [...guardOrder] },
      ],
      exports: [
        APP_CONFIG_TOKEN,
        APP_LOGGER,
        SECURITY_POLICY,
        SECURITY_EVENTS,
        AUDIT_SERVICE,
        AUTHORIZER,
        WORKFLOW_ENGINE,
        WORKFLOW_DEFINITION_SERVICE,
        TASK_SERVICE,
        SLA_SERVICE,
        ESCALATION_SERVICE,
        CASE_SERVICE,
        COMMENT_SERVICE,
        ATTACHMENT_SERVICE,
        HISTORY_RECORDER,
        MEMBER_DIRECTORY,
        GUARD_ORDER,
        /*
         * The module, not the provider. `PrismaService` belongs to `DatabaseModule`, and
         * Nest refuses to export a provider a module does not own — re-exporting the module
         * is how an importer of this one still gets it.
         */
        DatabaseModule,
      ],
    };
  }
}

/**
 * An identity provider that authenticates nobody.
 *
 * The default, deliberately. This application administers an existing deployment's
 * workflows, so it must authenticate against whatever that deployment already uses — and a
 * default local provider here would be a second, weaker way in to the same data.
 */
function refusingIdentityProvider(): IdentityProvider {
  const refuse = (): never => {
    throw new Error(
      'No identity provider is configured. This application authenticates against the ' +
        'deployment it administers; wire one in WorkflowAdminModule.forRoot.',
    );
  };

  return {
    id: 'none',
    kind: 'local',
    supportsPasswordAuthentication: false,
    supportsCentralSessionRevocation: false,
    authenticate: async () => refuse(),
    validateAccessToken: async () => refuse(),
    getProfile: async () => refuse(),
    logout: async () => undefined,
    revokeSessions: async () => refuse(),
    mapRoles: () => ({ roles: [], isSuperAdmin: false, organizationId: null, unmapped: [] }),
    // `ok: false` rather than throwing, so a readiness probe reports the misconfiguration
    // instead of a 500 that looks like a crash.
    health: async () => ({
      ok: false,
      detail: 'No identity provider is configured for this application.',
    }),
  };
}

/**
 * A document port that finds nothing.
 *
 * The default when the document module is not installed. A step that requires evidence then
 * cannot be satisfied — which is the correct and visible outcome, rather than a requirement
 * that silently passes.
 */
function refusingDocumentPort(): DocumentPort {
  return {
    find: async () => null,
    canRead: async () => false,
  };
}
