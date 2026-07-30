import { ModuleRegistryError } from './errors';
import { assertNoCycles } from './resolve';
import { moduleCatalogSchema, type ModuleCatalogEntry } from './schema';

/**
 * The approved module catalog.
 *
 * Seven capabilities every TrustOS vertical needs and none of them should build
 * twice. Read the header of `schema.ts` for why the declarative surface lives
 * here rather than inside each module package.
 *
 * Conventions used throughout:
 *
 *   * Permission keys, audit actions and flag keys are namespaced under the
 *     module id, and are permanent. Add keys; never rename one.
 *   * Prisma fragments are numbered from 20, leaving 00–09 for the framework
 *     schema and 10–19 for a product's own models. The number is the merge
 *     order, so a fragment that references another module's model must sort
 *     after it.
 *   * `suggestedRoles` is advice for the application's seed, not an instruction.
 *     Nothing in the module system can grant a permission.
 */

const OWNER = 'TrustOS Platform Engineering';
const VERSION = '0.1.0';
const MINIMUM_FRAMEWORK = '0.1.0';

const READ_ROLES = ['organization_owner', 'administrator', 'operator', 'auditor'];
const WRITE_ROLES = ['organization_owner', 'administrator'];

/** Reduces the repetition of `packaging` without hiding what it contains. */
function packaging(id: string, className: string) {
  return {
    packageName: `@trustos/module-${id}`,
    directory: `packages/modules/${id}`,
    nestModule: { className, importPath: `@trustos/module-${id}/nest` },
  };
}

const RAW_CATALOG: unknown[] = [
  // ==========================================================================
  // file-storage
  //
  // Installed first in practice: `document` depends on it, so the registry's
  // topological order puts it ahead. It owns the only code in the framework that
  // turns a caller-supplied string into a filesystem path, which is why its
  // containment tests are the ones to read before changing it.
  // ==========================================================================
  {
    metadata: {
      id: 'file-storage',
      name: 'File Storage',
      description:
        'Provider-abstracted object storage with checksums, versioning and per-organization key namespaces. Ships a local filesystem provider.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['storage', 'files', 'infrastructure'],
    },
    packaging: packaging('file-storage', 'FileStorageModule'),
    permissions: [
      {
        key: 'file-storage.file.list',
        description: 'List stored objects in the current organization.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'file-storage.file.read',
        description: 'Read an object and its metadata.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'file-storage.file.write',
        description: 'Store a new object or a new version of one.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'file-storage.file.delete',
        description: 'Retire an object.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    routes: [
      {
        method: 'GET',
        path: '/files',
        permission: 'file-storage.file.list',
        summary: 'List stored objects.',
      },
      {
        method: 'POST',
        path: '/files',
        permission: 'file-storage.file.write',
        summary: 'Store an object.',
      },
      {
        method: 'GET',
        path: '/files/:id',
        permission: 'file-storage.file.read',
        summary: 'Read object metadata.',
      },
      {
        method: 'GET',
        path: '/files/:id/content',
        permission: 'file-storage.file.read',
        summary: 'Download object content.',
      },
      {
        method: 'GET',
        path: '/files/:id/versions',
        permission: 'file-storage.file.read',
        summary: 'List an object version history.',
      },
      {
        method: 'DELETE',
        path: '/files/:id',
        permission: 'file-storage.file.delete',
        summary: 'Retire an object.',
      },
    ],
    auditEvents: [
      {
        action: 'file-storage.object.stored',
        entityType: 'StoredObject',
        description: 'An object or a new version of one was written.',
      },
      {
        action: 'file-storage.object.read',
        entityType: 'StoredObject',
        description: 'Object content was downloaded.',
      },
      {
        action: 'file-storage.object.deleted',
        entityType: 'StoredObject',
        description: 'An object was retired.',
      },
      {
        action: 'file-storage.object.checksum-mismatch',
        entityType: 'StoredObject',
        description: 'Stored content did not match its recorded checksum.',
      },
    ],
    featureFlags: [
      {
        key: 'file-storage.versioning',
        description: 'Keep previous versions when an object is overwritten.',
        defaultValue: true,
      },
    ],
    migrations: [
      {
        id: 'file-storage-init',
        description: 'StoredObject and StoredObjectVersion tables.',
        schemaFragment: 'prisma/schema/20-file-storage.prisma',
      },
    ],
    environment: [
      {
        name: 'FILE_STORAGE_ROOT',
        description: 'Directory the local provider writes into. Relative paths resolve from cwd.',
      },
      {
        name: 'FILE_STORAGE_MAX_BYTES',
        description: 'Largest object accepted, in bytes.',
      },
    ],
    extensionPoints: [
      {
        name: 'Storage provider',
        port: 'StorageProvider',
        description:
          'Where bytes live. Implement this to move from local disk to object storage without touching callers.',
        provided: ['LocalStorageProvider', 'InMemoryStorageProvider'],
      },
      {
        name: 'Object metadata store',
        port: 'StoredObjectStore',
        description: 'Where object rows live. The Prisma implementation is tenant-scoped.',
        provided: ['PrismaStoredObjectStore'],
      },
    ],
    outOfScope: [
      'Cloud object storage (S3, GCS, Azure Blob)',
      'Signed URLs and direct-to-provider uploads',
      'Streaming uploads and downloads (content crosses the wire base64 encoded)',
      'Server-side encryption key management',
      'Virus scanning',
    ],
  },

  // ==========================================================================
  // notification
  // ==========================================================================
  {
    metadata: {
      id: 'notification',
      name: 'Notification',
      description:
        'Templated messages over email, Telegram and webhooks, with per-tenant channel configuration, a retry queue and full delivery history. Mock adapters only.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'experimental',
      tags: ['messaging', 'delivery'],
    },
    packaging: packaging('notification', 'NotificationModule'),
    permissions: [
      {
        key: 'notification.message.read',
        description: 'View messages and their delivery status.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'notification.message.send',
        description: 'Send a message and retry a failed one.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'notification.template.read',
        description: 'View message templates.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'notification.template.manage',
        description: 'Create, change or retire a message template.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'notification.settings.read',
        description: 'View this organization channel settings.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'notification.settings.manage',
        description: 'Change this organization channel settings and sender identity.',
        suggestedRoles: ['organization_owner'],
      },
    ],
    routes: [
      {
        method: 'GET',
        path: '/notifications/messages',
        permission: 'notification.message.read',
        summary: 'List messages and delivery status.',
      },
      {
        method: 'GET',
        path: '/notifications/messages/:id',
        permission: 'notification.message.read',
        summary: 'Read one message with its delivery attempts.',
      },
      {
        method: 'POST',
        path: '/notifications/messages',
        permission: 'notification.message.send',
        summary: 'Render a template and queue it for delivery.',
      },
      {
        method: 'POST',
        path: '/notifications/messages/:id/retry',
        permission: 'notification.message.send',
        summary: 'Retry a failed message.',
      },
      {
        method: 'GET',
        path: '/notifications/templates',
        permission: 'notification.template.read',
        summary: 'List message templates.',
      },
      {
        method: 'POST',
        path: '/notifications/templates',
        permission: 'notification.template.manage',
        summary: 'Create a message template.',
      },
      {
        method: 'PUT',
        path: '/notifications/templates/:id',
        permission: 'notification.template.manage',
        summary: 'Update a message template.',
      },
      {
        method: 'DELETE',
        path: '/notifications/templates/:id',
        permission: 'notification.template.manage',
        summary: 'Retire a message template.',
      },
      {
        method: 'GET',
        path: '/notifications/settings',
        permission: 'notification.settings.read',
        summary: 'Read this organization channel settings.',
      },
      {
        method: 'PUT',
        path: '/notifications/settings',
        permission: 'notification.settings.manage',
        summary: 'Update this organization channel settings.',
      },
    ],
    auditEvents: [
      {
        action: 'notification.message.queued',
        entityType: 'NotificationMessage',
        description: 'A message was rendered and accepted for delivery.',
      },
      {
        action: 'notification.message.sent',
        entityType: 'NotificationMessage',
        description: 'A channel accepted the message.',
      },
      {
        action: 'notification.message.failed',
        entityType: 'NotificationMessage',
        description: 'A delivery attempt failed and will be retried.',
      },
      {
        action: 'notification.message.dead-lettered',
        entityType: 'NotificationMessage',
        description: 'A message exhausted its attempts and will not be retried.',
      },
      {
        action: 'notification.template.created',
        entityType: 'NotificationTemplate',
        description: 'A template was created.',
      },
      {
        action: 'notification.template.updated',
        entityType: 'NotificationTemplate',
        description: 'A template body or variable list changed.',
      },
      {
        action: 'notification.template.deleted',
        entityType: 'NotificationTemplate',
        description: 'A template was retired.',
      },
      {
        action: 'notification.settings.updated',
        entityType: 'NotificationSettings',
        description: 'An organization channel configuration changed.',
      },
    ],
    featureFlags: [
      {
        key: 'notification.channel.email',
        description: 'Deliver messages addressed to the email channel.',
        defaultValue: true,
      },
      {
        key: 'notification.channel.telegram',
        description: 'Deliver messages addressed to the Telegram channel.',
        defaultValue: false,
      },
      {
        key: 'notification.channel.webhook',
        description: 'Deliver messages addressed to the webhook channel.',
        defaultValue: false,
      },
    ],
    migrations: [
      {
        id: 'notification-init',
        description: 'NotificationTemplate, NotificationMessage and NotificationAttempt tables.',
        schemaFragment: 'prisma/schema/21-notification.prisma',
      },
    ],
    environment: [
      {
        name: 'NOTIFICATION_DEFAULT_SENDER',
        description: 'Sender identity used when an organization has not set one.',
      },
      {
        name: 'NOTIFICATION_MAX_ATTEMPTS',
        description: 'Delivery attempts before a message is dead-lettered.',
      },
      {
        name: 'NOTIFICATION_WEBHOOK_TIMEOUT_MS',
        description: 'Timeout applied to a webhook delivery attempt.',
      },
    ],
    extensionPoints: [
      {
        name: 'Delivery channel',
        port: 'NotificationChannel',
        description:
          'One transport. Replace a mock adapter with a real provider without touching the queue, the templates or the audit trail.',
        provided: ['MockEmailChannel', 'MockTelegramChannel', 'MockWebhookChannel'],
      },
      {
        name: 'Retry queue',
        port: 'RetryQueue',
        description:
          'Where pending deliveries wait. The in-memory implementation is process-local and is not a production queue.',
        provided: ['InMemoryRetryQueue'],
      },
      {
        name: 'Message store',
        port: 'NotificationStore',
        description: 'Where templates, messages and attempts live.',
        provided: ['PrismaNotificationStore'],
      },
    ],
    outOfScope: [
      'Real email providers (SMTP, SES, SendGrid)',
      'Real Telegram Bot API calls',
      'Redis or Kafka backed queues',
      'Scheduled digests and batching',
      'Inbound message handling',
    ],
  },

  // ==========================================================================
  // document
  // ==========================================================================
  {
    metadata: {
      id: 'document',
      name: 'Document',
      description:
        'Categorised documents with metadata, append-only version history, soft delete and per-organization ownership. Bytes are held by the file-storage module.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'experimental',
      tags: ['documents', 'records'],
    },
    packaging: packaging('document', 'DocumentModule'),
    dependencies: [
      {
        moduleId: 'file-storage',
        versionRange: '^0.1.0',
        reason:
          'Document content is stored through the StorageProvider port rather than by a second implementation of object storage.',
      },
    ],
    permissions: [
      {
        key: 'document.document.read',
        description: 'List and read document metadata.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'document.document.upload',
        description: 'Upload a document or a new version of one.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'document.document.update',
        description: 'Change a document title, category or metadata.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'document.document.delete',
        description: 'Retire a document.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'document.version.read',
        description: 'Read a document version history.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'document.category.read',
        description: 'List document categories.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'document.category.manage',
        description: 'Create or retire a document category.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    routes: [
      {
        method: 'GET',
        path: '/documents',
        permission: 'document.document.read',
        summary: 'List documents.',
      },
      {
        method: 'GET',
        path: '/documents/categories',
        permission: 'document.category.read',
        summary: 'List document categories.',
      },
      {
        method: 'POST',
        path: '/documents/categories',
        permission: 'document.category.manage',
        summary: 'Create a document category.',
      },
      {
        method: 'GET',
        path: '/documents/:id',
        permission: 'document.document.read',
        summary: 'Read one document.',
      },
      {
        method: 'POST',
        path: '/documents',
        permission: 'document.document.upload',
        summary: 'Upload a document.',
      },
      {
        method: 'POST',
        path: '/documents/:id/versions',
        permission: 'document.document.upload',
        summary: 'Upload a new version of a document.',
      },
      {
        method: 'GET',
        path: '/documents/:id/content',
        permission: 'document.document.read',
        summary: 'Download document content.',
      },
      {
        method: 'GET',
        path: '/documents/:id/versions',
        permission: 'document.version.read',
        summary: 'List a document version history.',
      },
      {
        method: 'PUT',
        path: '/documents/:id',
        permission: 'document.document.update',
        summary: 'Update document metadata.',
      },
      {
        method: 'DELETE',
        path: '/documents/:id',
        permission: 'document.document.delete',
        summary: 'Retire a document.',
      },
    ],
    auditEvents: [
      {
        action: 'document.document.uploaded',
        entityType: 'Document',
        description: 'A document was created.',
      },
      {
        action: 'document.version.created',
        entityType: 'DocumentVersion',
        description: 'A new version of a document was stored.',
      },
      {
        action: 'document.document.updated',
        entityType: 'Document',
        description: 'Document metadata changed.',
      },
      {
        action: 'document.document.deleted',
        entityType: 'Document',
        description: 'A document was retired.',
      },
      {
        action: 'document.category.created',
        entityType: 'DocumentCategory',
        description: 'A category was created.',
      },
      {
        action: 'document.document.downloaded',
        entityType: 'Document',
        description: 'Document content was read.',
      },
    ],
    featureFlags: [
      {
        key: 'document.versioning',
        description: 'Keep previous versions when a document is replaced.',
        defaultValue: true,
      },
    ],
    migrations: [
      {
        id: 'document-init',
        description: 'DocumentCategory, Document and DocumentVersion tables.',
        schemaFragment: 'prisma/schema/22-document.prisma',
      },
    ],
    environment: [
      {
        name: 'DOCUMENT_MAX_UPLOAD_BYTES',
        description: 'Largest document accepted, in bytes.',
      },
      {
        name: 'DOCUMENT_ALLOWED_MIME_TYPES',
        description: 'Comma-separated allow-list of content types.',
      },
    ],
    extensionPoints: [
      {
        name: 'Document store',
        port: 'DocumentStore',
        description: 'Where documents, versions and categories live.',
        provided: ['PrismaDocumentStore'],
      },
      {
        name: 'Content backend',
        port: 'StorageProvider',
        description:
          'Supplied by the file-storage module. Swapping it changes where document bytes live and nothing else.',
        provided: ['LocalStorageProvider', 'InMemoryStorageProvider'],
      },
    ],
    outOfScope: [
      'Cloud storage backends',
      'Streaming uploads and downloads (content crosses the wire base64 encoded)',
      'Text extraction, OCR and thumbnails',
      'Digital signatures and PDF manipulation',
      'Retention policy enforcement',
    ],
  },

  // ==========================================================================
  // workflow
  // ==========================================================================
  {
    metadata: {
      id: 'workflow',
      name: 'Workflow',
      description:
        'Approval workflows with task assignment, append-only approval history, SLA tracking and escalation hooks. Includes a maker-checker definition.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'experimental',
      tags: ['approvals', 'governance'],
    },
    packaging: packaging('workflow', 'WorkflowModule'),
    permissions: [
      {
        key: 'workflow.definition.read',
        description: 'View workflow definitions.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'workflow.definition.manage',
        description: 'Register or retire a workflow definition.',
        suggestedRoles: ['organization_owner'],
      },
      {
        key: 'workflow.instance.read',
        description: 'View workflow instances and their history.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'workflow.instance.start',
        description: 'Start a workflow instance.',
        suggestedRoles: ['organization_owner', 'administrator', 'operator'],
      },
      {
        key: 'workflow.instance.cancel',
        description: 'Cancel a running workflow instance.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'workflow.task.read',
        description: 'View assigned approval tasks.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'workflow.task.act',
        description: 'Approve or reject an assigned task.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    routes: [
      {
        method: 'GET',
        path: '/workflows/definitions',
        permission: 'workflow.definition.read',
        summary: 'List workflow definitions.',
      },
      {
        method: 'POST',
        path: '/workflows/definitions',
        permission: 'workflow.definition.manage',
        summary: 'Register a workflow definition.',
      },
      {
        method: 'GET',
        path: '/workflows/instances',
        permission: 'workflow.instance.read',
        summary: 'List workflow instances.',
      },
      {
        method: 'POST',
        path: '/workflows/instances',
        permission: 'workflow.instance.start',
        summary: 'Start a workflow instance.',
      },
      {
        method: 'GET',
        path: '/workflows/instances/:id',
        permission: 'workflow.instance.read',
        summary: 'Read one workflow instance.',
      },
      {
        method: 'GET',
        path: '/workflows/instances/:id/history',
        permission: 'workflow.instance.read',
        summary: 'Read the approval history of an instance.',
      },
      {
        method: 'POST',
        path: '/workflows/instances/:id/cancel',
        permission: 'workflow.instance.cancel',
        summary: 'Cancel a running instance.',
      },
      {
        method: 'GET',
        path: '/workflows/tasks',
        permission: 'workflow.task.read',
        summary: 'List tasks assigned to the caller.',
      },
      {
        method: 'POST',
        path: '/workflows/tasks/:id/approve',
        permission: 'workflow.task.act',
        summary: 'Approve a task.',
      },
      {
        method: 'POST',
        path: '/workflows/tasks/:id/reject',
        permission: 'workflow.task.act',
        summary: 'Reject a task.',
      },
    ],
    auditEvents: [
      {
        action: 'workflow.definition.created',
        entityType: 'WorkflowDefinition',
        description: 'A workflow definition was registered.',
      },
      {
        action: 'workflow.instance.started',
        entityType: 'WorkflowInstance',
        description: 'An instance was started.',
      },
      {
        action: 'workflow.task.assigned',
        entityType: 'WorkflowTask',
        description: 'A task was assigned to an approver.',
      },
      {
        action: 'workflow.task.approved',
        entityType: 'WorkflowTask',
        description: 'A task was approved.',
      },
      {
        action: 'workflow.task.rejected',
        entityType: 'WorkflowTask',
        description: 'A task was rejected.',
      },
      {
        action: 'workflow.task.self-approval-blocked',
        entityType: 'WorkflowTask',
        description: 'A submitter attempted to approve their own request.',
      },
      {
        action: 'workflow.instance.completed',
        entityType: 'WorkflowInstance',
        description: 'An instance reached a terminal state.',
      },
      {
        action: 'workflow.instance.cancelled',
        entityType: 'WorkflowInstance',
        description: 'An instance was cancelled.',
      },
      {
        action: 'workflow.sla.breached',
        entityType: 'WorkflowTask',
        description: 'A task passed its SLA without a decision.',
      },
      {
        action: 'workflow.task.escalated',
        entityType: 'WorkflowTask',
        description: 'An escalation hook ran for a breached task.',
      },
    ],
    featureFlags: [
      {
        key: 'workflow.escalation',
        description: 'Run escalation hooks when a task breaches its SLA.',
        defaultValue: true,
      },
    ],
    migrations: [
      {
        id: 'workflow-init',
        description:
          'WorkflowDefinition, WorkflowInstance, WorkflowTask and WorkflowHistoryEntry tables.',
        schemaFragment: 'prisma/schema/23-workflow.prisma',
      },
    ],
    environment: [
      {
        name: 'WORKFLOW_DEFAULT_SLA_MINUTES',
        description: 'SLA applied to an approval step that does not declare one.',
      },
    ],
    extensionPoints: [
      {
        name: 'Escalation hook',
        port: 'EscalationHook',
        description:
          'Runs when a task breaches its SLA. Wire it to the notification module, a pager, or nothing.',
        provided: ['RecordingEscalationHook'],
      },
      {
        name: 'Workflow store',
        port: 'WorkflowStore',
        description: 'Where definitions, instances, tasks and history live.',
        provided: ['PrismaWorkflowStore'],
      },
    ],
    outOfScope: [
      'BPMN or a visual designer',
      'Parallel and conditional branching',
      'Timers driven by an external scheduler',
      'Delegation and out-of-office reassignment',
    ],
  },

  // ==========================================================================
  // reporting
  // ==========================================================================
  {
    metadata: {
      id: 'reporting',
      name: 'Reporting',
      description:
        'Declarative report definitions with filtering, pagination, CSV export, a PDF renderer port and a scheduled-report interface.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'experimental',
      tags: ['reporting', 'export'],
    },
    packaging: packaging('reporting', 'ReportingModule'),
    permissions: [
      {
        key: 'reporting.report.read',
        description: 'List report definitions.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'reporting.report.run',
        description: 'Run a report and page through its rows.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'reporting.report.export',
        description: 'Export a report to a file.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'reporting.schedule.read',
        description: 'View scheduled reports.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'reporting.schedule.manage',
        description: 'Create or remove a scheduled report.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    routes: [
      {
        method: 'GET',
        path: '/reports',
        permission: 'reporting.report.read',
        summary: 'List report definitions.',
      },
      {
        method: 'GET',
        path: '/reports/schedules',
        permission: 'reporting.schedule.read',
        summary: 'List scheduled reports.',
      },
      {
        method: 'POST',
        path: '/reports/schedules',
        permission: 'reporting.schedule.manage',
        summary: 'Schedule a report.',
      },
      {
        method: 'DELETE',
        path: '/reports/schedules/:id',
        permission: 'reporting.schedule.manage',
        summary: 'Remove a scheduled report.',
      },
      {
        method: 'GET',
        path: '/reports/:id',
        permission: 'reporting.report.read',
        summary: 'Read one report definition.',
      },
      {
        method: 'POST',
        path: '/reports/:id/run',
        permission: 'reporting.report.run',
        summary: 'Run a report.',
      },
      {
        method: 'POST',
        path: '/reports/:id/export',
        permission: 'reporting.report.export',
        summary: 'Export a report.',
      },
    ],
    auditEvents: [
      {
        action: 'reporting.report.run',
        entityType: 'ReportDefinition',
        description: 'A report was run.',
      },
      {
        action: 'reporting.report.exported',
        entityType: 'ReportDefinition',
        description: 'A report was exported to a file.',
      },
      {
        action: 'reporting.schedule.created',
        entityType: 'ReportSchedule',
        description: 'A report was scheduled.',
      },
      {
        action: 'reporting.schedule.deleted',
        entityType: 'ReportSchedule',
        description: 'A schedule was removed.',
      },
    ],
    featureFlags: [
      {
        key: 'reporting.export.pdf',
        description: 'Offer PDF export. Off until a renderer is wired in.',
        defaultValue: false,
      },
    ],
    migrations: [
      {
        id: 'reporting-init',
        description: 'ReportSchedule table.',
        schemaFragment: 'prisma/schema/24-reporting.prisma',
      },
    ],
    environment: [
      {
        name: 'REPORTING_MAX_EXPORT_ROWS',
        description: 'Row ceiling for a single export.',
      },
    ],
    extensionPoints: [
      {
        name: 'Report data source',
        port: 'ReportDataSource',
        description:
          'Supplies the rows for one report definition. Applications register their own; the module owns filtering, pagination and export.',
        provided: ['createPrismaReportDataSource', 'createStaticReportDataSource'],
      },
      {
        name: 'PDF renderer',
        port: 'PdfRenderer',
        description:
          'Interface only. The shipped implementation refuses with a clear message rather than producing an empty file.',
        provided: ['UnavailablePdfRenderer'],
      },
      {
        name: 'Schedule store',
        port: 'ReportScheduleStore',
        description:
          'Where schedules live. The module computes the next run time; the application decides what triggers it.',
        provided: ['PrismaReportScheduleStore'],
      },
    ],
    outOfScope: [
      'Charts and visualisations',
      'A PDF rendering implementation',
      'A scheduler runtime (cron, Redis, Kafka)',
      'Ad-hoc query building by end users',
    ],
  },

  // ==========================================================================
  // search
  //
  // The only module with no tables of its own: it queries what other modules
  // already store. That is deliberate — a search index that duplicates data is a
  // second copy to keep tenant-correct.
  // ==========================================================================
  {
    metadata: {
      id: 'search',
      name: 'Search',
      description:
        'Global search across registered module adapters, with permission filtering, tenant verification, ranking and pagination. Database-backed; no external engine.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'experimental',
      tags: ['search', 'discovery'],
    },
    packaging: packaging('search', 'SearchModule'),
    permissions: [
      {
        key: 'search.query.execute',
        description: 'Run a global search.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'search.source.read',
        description: 'List the searchable sources available to the caller.',
        suggestedRoles: READ_ROLES,
      },
    ],
    routes: [
      {
        method: 'GET',
        path: '/search',
        permission: 'search.query.execute',
        summary: 'Search across every source the caller may read.',
      },
      {
        method: 'GET',
        path: '/search/sources',
        permission: 'search.source.read',
        summary: 'List searchable sources.',
      },
    ],
    auditEvents: [
      {
        action: 'search.query.executed',
        entityType: 'SearchQuery',
        description: 'A global search was run. The term is recorded; results are not.',
      },
      {
        action: 'search.result.dropped',
        entityType: 'SearchQuery',
        description: 'An adapter returned a result from another organization and it was discarded.',
      },
    ],
    featureFlags: [
      {
        key: 'search.ranking.weighted',
        description: 'Rank by field weight and match position rather than by source order.',
        defaultValue: true,
      },
    ],
    migrations: [],
    environment: [
      {
        name: 'SEARCH_MAX_RESULTS_PER_SOURCE',
        description: 'Rows requested from each adapter before merging and ranking.',
      },
    ],
    extensionPoints: [
      {
        name: 'Search adapter',
        port: 'SearchAdapter',
        description:
          'One searchable source. Declares the permission a caller needs, and the service never returns a hit from a source the caller cannot read.',
        provided: ['createPrismaSearchAdapter', 'createStaticSearchAdapter'],
      },
      {
        name: 'Ranker',
        port: 'Ranker',
        description: 'Scores and orders merged hits.',
        provided: ['weightedRanker', 'sourceOrderRanker'],
      },
    ],
    outOfScope: [
      'Elasticsearch and OpenSearch',
      'Fuzzy matching, stemming and synonyms',
      'A separate search index',
      'Faceting and aggregations',
    ],
  },

  // ==========================================================================
  // feature-flags
  // ==========================================================================
  {
    metadata: {
      id: 'feature-flags',
      name: 'Feature Flags',
      description:
        'Boolean flags with percentage rollout, per-organization overrides, environment scoping and expiry dates, over a REST API.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['delivery', 'configuration'],
    },
    packaging: packaging('feature-flags', 'FeatureFlagsModule'),
    permissions: [
      {
        key: 'feature-flags.flag.read',
        description: 'List flags and their configuration.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'feature-flags.flag.manage',
        description: 'Create, change or remove a flag.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'feature-flags.flag.evaluate',
        description: 'Evaluate a flag for a subject.',
        suggestedRoles: READ_ROLES,
      },
    ],
    routes: [
      {
        method: 'GET',
        path: '/feature-flags',
        permission: 'feature-flags.flag.read',
        summary: 'List flags.',
      },
      {
        method: 'POST',
        path: '/feature-flags',
        permission: 'feature-flags.flag.manage',
        summary: 'Create a flag.',
      },
      {
        method: 'GET',
        path: '/feature-flags/:key',
        permission: 'feature-flags.flag.read',
        summary: 'Read one flag.',
      },
      {
        method: 'PUT',
        path: '/feature-flags/:key',
        permission: 'feature-flags.flag.manage',
        summary: 'Update a flag.',
      },
      {
        method: 'DELETE',
        path: '/feature-flags/:key',
        permission: 'feature-flags.flag.manage',
        summary: 'Remove a flag.',
      },
      {
        method: 'POST',
        path: '/feature-flags/:key/evaluate',
        permission: 'feature-flags.flag.evaluate',
        summary: 'Evaluate a flag for a subject.',
      },
    ],
    auditEvents: [
      {
        action: 'feature-flags.flag.created',
        entityType: 'FeatureFlag',
        description: 'A flag was created.',
      },
      {
        action: 'feature-flags.flag.updated',
        entityType: 'FeatureFlag',
        description: 'A flag configuration changed.',
      },
      {
        action: 'feature-flags.flag.deleted',
        entityType: 'FeatureFlag',
        description: 'A flag was removed.',
      },
      {
        action: 'feature-flags.flag.evaluated',
        entityType: 'FeatureFlag',
        description: 'A flag was evaluated. Recorded only when the audit flag is on.',
      },
    ],
    featureFlags: [
      {
        key: 'feature-flags.audit-evaluations',
        description:
          'Write an audit record for every evaluation. Off by default: evaluations are hot and the volume would drown the trail.',
        defaultValue: false,
      },
    ],
    migrations: [
      {
        id: 'feature-flags-init',
        description: 'FeatureFlag and FeatureFlagOverride tables.',
        schemaFragment: 'prisma/schema/25-feature-flag.prisma',
      },
    ],
    environment: [
      {
        name: 'FEATURE_FLAGS_ROLLOUT_SALT',
        description:
          'Salt for percentage-rollout bucketing. Changing it reshuffles every rollout, so set it once per environment.',
      },
    ],
    extensionPoints: [
      {
        name: 'Flag store',
        port: 'FeatureFlagStore',
        description: 'Where flags and per-organization overrides live.',
        provided: ['PrismaFeatureFlagStore'],
      },
    ],
    outOfScope: [
      'Third-party flag services (LaunchDarkly, Unleash)',
      'Streaming flag updates to clients',
      'Multivariate and string-valued flags',
      'Experiment analysis',
    ],
  },
  // ==========================================================================
  // The integration layer — phase 6.
  //
  // These differ from the modules above in one way worth stating: they are
  // framework packages rather than `packages/modules/*` packages, because they
  // are infrastructure the framework itself uses. `event-bus` publishes the
  // events `webhooks` delivers; `scheduler` enqueues into `jobs`. Installing one
  // adds a dependency and its documentation, and contributes no application
  // files — the wiring is a Nest module import in the composition root.
  //
  // Every one of them ships **no provider implementation**. That is the phase 6
  // boundary: the seam is the deliverable, and the adapter belongs to whatever
  // product is built on this.
  // ==========================================================================
  {
    metadata: {
      id: 'events',
      name: 'Event Bus',
      description:
        'Typed, versioned domain events with a schema registry, ordering per aggregate, retry, dead letters and replay. In-memory by default; no broker required.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['events', 'messaging', 'infrastructure'],
    },
    packaging: packaging('events', 'EventsModule'),
    permissions: [
      {
        key: 'events.catalog.read',
        description: 'Read the registered event schema catalog.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'events.deadletter.read',
        description: 'List events that failed permanently.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'events.deadletter.replay',
        description: 'Re-deliver a dead-lettered event after fixing its handler.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'events.deadletter.replayed',
        entityType: 'EventDeadLetter',
        description: 'An operator re-delivered an event that had failed permanently.',
      },
    ],
    // No migration of its own: the integration tables are part of the framework schema, which
    // every generated application already carries in `00-framework.prisma`. Declaring a fragment
    // here would claim a file the module does not own — and two modules claiming one file is a
    // merge order nobody can reason about.
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Event bus',
        port: 'EventBus',
        description:
          'Where events are delivered. Replace the in-memory implementation with an adapter over a broker; no publisher or subscriber changes.',
        provided: ['InMemoryEventBus'],
      },
      {
        name: 'Dead-letter store',
        port: 'DeadLetterStore',
        description: 'Where permanently failed events are kept for replay.',
        provided: ['InMemoryDeadLetterStore'],
      },
      {
        name: 'Delivery ledger',
        port: 'DeliveryLedger',
        description:
          'Suppresses a repeat delivery before the handler sees it. A database implementation must insert against a unique constraint rather than check-then-insert.',
        provided: ['InMemoryDeliveryLedger'],
      },
    ],
    outOfScope: [
      'Kafka, RabbitMQ, NATS and Redis Streams adapters',
      'Cross-process delivery (the in-memory bus is one process)',
      'Event sourcing and aggregate rehydration',
      'Exactly-once delivery (at-least-once, with deduplication at the consumer)',
    ],
  },

  {
    metadata: {
      id: 'webhook',
      name: 'Webhooks',
      description:
        'Outbound webhooks with HMAC-SHA256 signatures, overlapping secret rotation, replay protection, per-attempt delivery history and SSRF-checked destinations.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['webhooks', 'integration', 'outbound'],
    },
    packaging: packaging('webhook', 'WebhookModule'),
    dependencies: [
      {
        moduleId: 'events',
        versionRange: '^0.1.0',
        reason: 'The dispatcher subscribes to the bus; there is nothing to deliver without it.',
      },
    ],
    permissions: [
      {
        key: 'webhook.endpoint.read',
        description: 'List webhook endpoints and their health.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'webhook.endpoint.write',
        description: 'Create, update, pause and delete endpoints.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'webhook.secret.rotate',
        description: 'Rotate or revoke an endpoint signing secret.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'webhook.delivery.read',
        description: 'Read delivery history and attempt logs.',
        suggestedRoles: READ_ROLES,
      },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'webhook.endpoint.created',
        entityType: 'WebhookEndpoint',
        description: 'An endpoint was registered.',
      },
      {
        action: 'webhook.secret.rotated',
        entityType: 'WebhookEndpoint',
        description: 'A signing secret was rotated. Hints only; never values.',
      },
      {
        action: 'webhook.secret.revoked',
        entityType: 'WebhookEndpoint',
        description: 'A signing secret was revoked immediately.',
      },
      {
        action: 'webhook.endpoint.auto_disabled',
        entityType: 'WebhookEndpoint',
        description: 'An endpoint was disabled after sustained failure.',
      },
    ],
    // No migration of its own: the integration tables are part of the framework schema, which
    // every generated application already carries in `00-framework.prisma`. Declaring a fragment
    // here would claim a file the module does not own — and two modules claiming one file is a
    // merge order nobody can reason about.
    migrations: [],
    environment: [
      {
        name: 'WEBHOOK_ENCRYPTION_KEY',
        description:
          'At least 32 characters. Encrypts signing secrets at rest with AES-256-GCM. Generate with `openssl rand -base64 48`.',
      },
    ],
    extensionPoints: [
      {
        name: 'Secret cipher',
        port: 'SecretCipher',
        description:
          'How signing secrets are encrypted at rest. Replace to move the key into KMS or Vault.',
        provided: ['AesSecretCipher', 'PlaintextSecretCipher'],
      },
      {
        name: 'Delivery store',
        port: 'WebhookDeliveryStore',
        description:
          'The delivery queue. `enqueue` and `claimDue` must be atomic — see the port docstring for what a non-atomic implementation costs.',
        provided: ['InMemoryWebhookDeliveryStore'],
      },
    ],
    outOfScope: [
      'Inbound webhook receipt (this is the sending side)',
      'mTLS client certificates',
      'Per-endpoint rate limiting',
      'Webhook payload transformation and templating',
    ],
  },

  {
    metadata: {
      id: 'jobs',
      name: 'Background Jobs',
      description:
        'A durable job queue in the database: leased execution, retry with backoff, priority, progress, timeouts, cancellation and per-attempt history. No broker.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['jobs', 'queue', 'background'],
    },
    packaging: packaging('jobs', 'JobsModule'),
    permissions: [
      {
        key: 'jobs.job.read',
        description: 'List jobs and read their run history.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'jobs.job.cancel',
        description: 'Cancel a queued or running job.',
        suggestedRoles: WRITE_ROLES,
      },
      { key: 'jobs.job.retry', description: 'Re-queue a failed job.', suggestedRoles: WRITE_ROLES },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'jobs.job.cancelled',
        entityType: 'Job',
        description: 'A job was cancelled by an operator.',
      },
      { action: 'jobs.job.retried', entityType: 'Job', description: 'A failed job was re-queued.' },
    ],
    // No migration of its own: the integration tables are part of the framework schema, which
    // every generated application already carries in `00-framework.prisma`. Declaring a fragment
    // here would claim a file the module does not own — and two modules claiming one file is a
    // merge order nobody can reason about.
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Job store',
        port: 'JobStore',
        description:
          'The queue itself. `claim` must be atomic; a store that reads then writes runs every job twice the moment a second worker starts.',
        provided: ['InMemoryJobStore'],
      },
      {
        name: 'Job handler',
        port: 'JobHandlerDefinition',
        description: 'What a job type actually does. Registered at start-up with a payload schema.',
        provided: [],
      },
    ],
    outOfScope: [
      'Redis, SQS and RabbitMQ backends',
      'Job chaining, workflows and fan-out orchestration',
      'Cron expressions (that is the scheduler module)',
      'Distributed tracing of job execution',
    ],
  },

  {
    metadata: {
      id: 'scheduler',
      name: 'Scheduler',
      description:
        'Cron, interval and one-time schedules with real IANA timezone support, explicit daylight-saving handling, misfire policies and pause/resume. Enqueues jobs.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['scheduler', 'cron', 'background'],
    },
    packaging: packaging('scheduler', 'SchedulerModule'),
    dependencies: [
      {
        moduleId: 'jobs',
        versionRange: '^0.1.0',
        reason: 'A schedule enqueues a job rather than running work itself.',
      },
    ],
    permissions: [
      {
        key: 'scheduler.schedule.read',
        description: 'List schedules and their run history.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'scheduler.schedule.write',
        description: 'Create, update and delete schedules.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'scheduler.schedule.control',
        description: 'Pause, resume or trigger a schedule.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'scheduler.schedule.created',
        entityType: 'Schedule',
        description: 'A schedule was defined.',
      },
      {
        action: 'scheduler.schedule.paused',
        entityType: 'Schedule',
        description: 'A schedule was paused.',
      },
      {
        action: 'scheduler.schedule.resumed',
        entityType: 'Schedule',
        description: 'A schedule was resumed.',
      },
      {
        action: 'scheduler.schedule.triggered',
        entityType: 'Schedule',
        description: 'A schedule was triggered manually.',
      },
    ],
    // No migration of its own: the integration tables are part of the framework schema, which
    // every generated application already carries in `00-framework.prisma`. Declaring a fragment
    // here would claim a file the module does not own — and two modules claiming one file is a
    // merge order nobody can reason about.
    migrations: [],
    environment: [
      {
        name: 'SCHEDULER_TIMEZONE',
        description:
          'Default IANA timezone for schedules that do not name one. "Run at 2am" means nothing without it.',
      },
    ],
    extensionPoints: [
      {
        name: 'Schedule store',
        port: 'ScheduleStore',
        description:
          'Where schedules live. `claimDue` must advance nextRunAt atomically, or every replica fires every schedule.',
        provided: ['InMemoryScheduleStore'],
      },
    ],
    outOfScope: [
      'Sub-minute schedules',
      'Holiday and business-calendar awareness',
      'Distributed leader election (the atomic claim is the coordination)',
      'Six-field cron expressions with a seconds column',
    ],
  },

  {
    metadata: {
      id: 'adapter',
      name: 'Provider Adapters',
      description:
        'The five-method provider contract — initialize, health, capabilities, configuration, shutdown — with a registry, circuit-breaker-guarded calls and lifecycle management.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['providers', 'adapters', 'integration'],
    },
    packaging: packaging('adapter', 'AdapterModule'),
    permissions: [
      {
        key: 'adapter.provider.read',
        description: 'List providers, their capabilities and their health.',
        suggestedRoles: READ_ROLES,
      },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'adapter.provider.health_changed',
        entityType: 'Provider',
        description:
          'A provider changed health status. Recorded rather than only logged, because "when did this start" is the first question during an incident.',
      },
    ],
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Provider',
        port: 'Provider',
        description:
          'Every external system this platform talks to. The framework ships no implementation of it — that is the phase 6 boundary.',
        provided: ['BaseProvider'],
      },
    ],
    outOfScope: [
      'Any concrete provider implementation',
      'Payment, messaging or storage adapters',
      'Provider marketplaces and dynamic loading',
      'Per-provider billing and quota tracking',
    ],
  },

  {
    metadata: {
      id: 'import',
      name: 'Import',
      description:
        'Bulk import with CSV and JSON parsing, per-row validation, preview, dry run, all-or-nothing apply, rollback and a downloadable error report.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['import', 'bulk', 'data'],
    },
    packaging: packaging('import', 'ImportModule'),
    permissions: [
      {
        key: 'import.run.preview',
        description: 'Validate a file without importing it.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'import.run.apply',
        description: 'Import a validated file.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'import.run.rollback',
        description: 'Undo a completed import.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'import.run.read',
        description: 'List imports and download error reports.',
        suggestedRoles: READ_ROLES,
      },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'import.completed',
        entityType: 'ImportRun',
        description: 'An import was applied.',
      },
      {
        action: 'import.rolled_back',
        entityType: 'ImportRun',
        description: 'An import was undone.',
      },
    ],
    // No migration of its own: the integration tables are part of the framework schema, which
    // every generated application already carries in `00-framework.prisma`. Declaring a fragment
    // here would claim a file the module does not own — and two modules claiming one file is a
    // merge order nobody can reason about.
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'File parser',
        port: 'FileParser',
        description:
          'How a format becomes rows. Excel and ZIP are ports rather than implementations.',
        provided: ['CsvParser', 'JsonParser'],
      },
      {
        name: 'Import handler',
        port: 'ImportHandlerDefinition',
        description: 'What an import type validates and applies. Supplies the rollback too.',
        provided: [],
      },
    ],
    outOfScope: [
      'Excel and ZIP parsing (ports, not implementations)',
      'Column mapping user interfaces',
      'Streaming import of files larger than memory',
      'Malware scanning of uploads',
    ],
  },

  {
    metadata: {
      id: 'export',
      name: 'Export',
      description:
        'Streaming export to CSV, JSON and NDJSON with keyset pagination, bounded row counts, column selection and spreadsheet formula-injection escaping.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['export', 'reporting', 'data'],
    },
    packaging: packaging('export', 'ExportModule'),
    permissions: [
      {
        key: 'export.run.create',
        description: 'Run an export.',
        // Write roles, not read roles. An export is a bulk extraction of tenant data to a file
        // that leaves the system, which is a different act from reading a page of it on screen.
        suggestedRoles: WRITE_ROLES,
      },
      { key: 'export.run.read', description: 'List past exports.', suggestedRoles: READ_ROLES },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'export.completed',
        entityType: 'ExportRun',
        description:
          'An export finished. Records the filters, which is the answer to "what exactly did this file contain".',
      },
    ],
    // No migration of its own: the integration tables are part of the framework schema, which
    // every generated application already carries in `00-framework.prisma`. Declaring a fragment
    // here would claim a file the module does not own — and two modules claiming one file is a
    // merge order nobody can reason about.
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Export formatter',
        port: 'ExportFormatter',
        description: 'How rows become bytes, incrementally. Excel and PDF are ports.',
        provided: ['CsvFormatter', 'JsonFormatter', 'JsonLinesFormatter'],
      },
      {
        name: 'Export source',
        port: 'ExportSource',
        description:
          'Where rows come from, one page at a time. Must filter by organizationId — the port says so in capitals.',
        provided: [],
      },
      {
        name: 'Export sink',
        port: 'ExportSink',
        description: 'Where the bytes go: an HTTP response, a file, object storage.',
        provided: ['BufferSink'],
      },
    ],
    outOfScope: [
      'Excel and PDF rendering (ports, not implementations)',
      'Scheduled report delivery by email',
      'Chart and dashboard rendering',
      'Client-side export in the browser',
    ],
  },

  {
    metadata: {
      id: 'sync',
      name: 'Synchronization',
      description:
        'Pull, push and bidirectional synchronization with incremental watermarks, four conflict policies, run history and a conflict log. No provider integrations.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'experimental',
      tags: ['sync', 'integration', 'data'],
    },
    packaging: packaging('sync', 'SyncModule'),
    dependencies: [
      {
        moduleId: 'jobs',
        versionRange: '^0.1.0',
        reason: 'A synchronization run is executed as a background job.',
      },
    ],
    permissions: [
      {
        key: 'sync.connection.read',
        description: 'List sync connections and their run history.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'sync.connection.write',
        description: 'Create, pause and resume connections.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'sync.connection.run',
        description: 'Trigger a synchronization run.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'sync.conflict.resolve',
        description: 'Resolve a record two systems disagree about.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    // No routes.
    //
    // These modules ship services and lifecycle, not controllers. Their stores are ports the
    // application supplies — there is no Prisma implementation in the framework — so a controller
    // here would have nothing to inject. The application builds its own HTTP surface over the
    // service; the shape it should expose is documented rather than advertised, because a catalog
    // that advertises a route nothing serves is a catalog that lies.
    routes: [],
    auditEvents: [
      {
        action: 'sync.completed',
        entityType: 'SyncConnection',
        description: 'A synchronization run finished.',
      },
      {
        action: 'sync.conflict.resolved',
        entityType: 'SyncConflict',
        description: 'A conflict was resolved by a person.',
      },
      {
        action: 'sync.connection.paused',
        entityType: 'SyncConnection',
        description: 'A connection was paused.',
      },
      {
        action: 'sync.connection.resumed',
        entityType: 'SyncConnection',
        description: 'A connection was resumed.',
      },
    ],
    // No migration of its own: the integration tables are part of the framework schema, which
    // every generated application already carries in `00-framework.prisma`. Declaring a fragment
    // here would claim a file the module does not own — and two modules claiming one file is a
    // merge order nobody can reason about.
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Sync connector',
        port: 'SyncConnector',
        description:
          "The other system. Fetches remote changes, applies local ones, and reports the remote's own watermark. The framework ships none.",
        provided: [],
      },
      {
        name: 'Sync store',
        port: 'SyncStore',
        description: 'Where connections, runs and conflicts live.',
        provided: ['InMemorySyncStore'],
      },
    ],
    outOfScope: [
      'Any concrete external system integration',
      'Real-time or change-data-capture synchronization',
      'Schema mapping and field transformation user interfaces',
      'Three-way merge of conflicting records',
    ],
  },

  // ==========================================================================
  // ai
  //
  // The gateway and everything a model call passes through. `rag` and `agent` both depend on it,
  // because neither can work without a gateway — and a module that cannot make a request is a
  // module whose installation looks successful and does nothing.
  // ==========================================================================
  {
    metadata: {
      id: 'ai',
      name: 'AI Platform',
      description:
        'The AI gateway and everything a model call has to pass through: model registry, prompt registry, guardrails, tenant policy, routing, cost accounting and caching. Provider-neutral; ships no provider credentials.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['ai', 'gateway', 'infrastructure'],
    },
    packaging: packaging('ai', 'AiModule'),
    permissions: [
      {
        key: 'ai.model.read',
        description: 'List the models this organization may use.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'ai.model.manage',
        description: 'Register, retire and reprice models.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'ai.prompt.read',
        description: 'Read prompts and their versions.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'ai.prompt.write',
        description: 'Draft and edit a prompt version. Not enough to publish one.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'ai.prompt.approve',
        description:
          'Approve a prompt version. Separate from writing, because the author may not approve their own.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'ai.prompt.publish',
        description:
          'Publish an approved version, making it live. Separate again: three people, not one.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'ai.policy.read',
        description: "Read this organization's AI policy.",
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'ai.policy.manage',
        description: 'Change which models, tools and knowledge bases are permitted.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'ai.usage.read',
        description: 'Read AI cost and usage reports.',
        suggestedRoles: READ_ROLES,
      },
    ],
    // No routes.
    //
    // Same reasoning as the integration modules: this ships services and lifecycle, not
    // controllers. Every store is a port the application supplies, so a controller here would
    // have nothing to inject — and a catalog that advertises a route nothing serves is a catalog
    // that lies.
    routes: [],
    auditEvents: [
      {
        action: 'ai.request.completed',
        entityType: 'AiRequest',
        description:
          'A model was called. Records the model, cost, outcome and policy decision — never the prompt or the completion.',
      },
      {
        action: 'ai.request.blocked',
        entityType: 'AiRequest',
        description: 'A guardrail or a policy refused a request.',
      },
      {
        action: 'ai.prompt.published',
        entityType: 'AiPromptVersion',
        description: 'A prompt version was published and became live.',
      },
      {
        action: 'ai.prompt.rolled_back',
        entityType: 'AiPromptVersion',
        description: 'A previously approved prompt version was made live again.',
      },
      {
        action: 'ai.policy.changed',
        entityType: 'AiPolicy',
        description: "An organization's AI policy was changed.",
      },
      {
        action: 'ai.model.retired',
        entityType: 'AiModel',
        description: 'A model was retired and can no longer be requested.',
      },
    ],
    // No migration of its own: the AI tables are part of the framework schema, which every
    // generated application already carries in `00-framework.prisma`.
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Provider adapter',
        port: 'AiProviderAdapter',
        description:
          'The provider. One adapter per provider — OpenAI, Anthropic, Gemini, OpenRouter, xAI, Ollama, vLLM. The framework ships an echo adapter for tests and no real one, because shipping a provider is choosing one.',
        provided: ['EchoAdapter'],
      },
      {
        name: 'Model store',
        port: 'ModelStore',
        description: 'Where the model catalog lives.',
        provided: ['InMemoryModelRegistry'],
      },
      {
        name: 'Prompt store',
        port: 'PromptStore',
        description: 'Where prompts and their versions live.',
        provided: ['InMemoryPromptStore'],
      },
      {
        name: 'Cache store',
        port: 'CacheStore',
        description:
          'Where cached responses live. The key includes the tenant structurally, so no adapter can omit it.',
        provided: ['InMemoryCacheStore'],
      },
      {
        name: 'Cost store',
        port: 'CostStore',
        description: 'Where spend is recorded and aggregated.',
        provided: ['InMemoryCostStore'],
      },
    ],
    outOfScope: [
      'Provider credentials and accounts',
      'Fine-tuning and training pipelines',
      'Image, audio and video generation',
      'A chat user interface',
      'Business-specific agents and prompts',
      'Model hosting and GPU infrastructure',
    ],
  },

  // ==========================================================================
  // rag
  // ==========================================================================
  {
    metadata: {
      id: 'rag',
      name: 'Retrieval-Augmented Generation',
      description:
        'Answering from documents: chunking, embedding, a vector-store interface, hybrid search with reciprocal rank fusion, citation checking and per-collection access control.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['ai', 'search', 'knowledge'],
    },
    packaging: packaging('rag', 'RagModule'),
    dependencies: [
      {
        moduleId: 'ai',
        versionRange: '^0.1.0',
        reason:
          'Retrieval produces an answer by calling a model, and every model call goes through the gateway.',
      },
    ],
    permissions: [
      {
        key: 'rag.collection.read',
        description: 'List knowledge collections. Reading a collection needs its own permissions.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'rag.collection.manage',
        description: 'Create a collection and set who may read it.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'rag.document.write',
        description: 'Add and update documents, which re-embeds them.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'rag.document.delete',
        description: 'Remove a document and its vectors.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'rag.search',
        description: 'Search collections this actor may read.',
        suggestedRoles: READ_ROLES,
      },
    ],
    routes: [],
    auditEvents: [
      {
        action: 'rag.collection.created',
        entityType: 'AiKnowledgeCollection',
        description:
          'A knowledge collection was created, with its visibility and read permissions.',
      },
      {
        action: 'rag.collection.access_changed',
        entityType: 'AiKnowledgeCollection',
        description: 'Who may read a collection changed. The most consequential edit in retrieval.',
      },
      {
        action: 'rag.document.ingested',
        entityType: 'AiKnowledgeDocument',
        description: 'A document was added or updated and embedded.',
      },
      {
        action: 'rag.document.removed',
        entityType: 'AiKnowledgeDocument',
        description: 'A document and its vectors were removed.',
      },
    ],
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Vector store',
        port: 'VectorStore',
        description:
          'Where vectors live. An interface on purpose: pgvector, Qdrant, Pinecone, Weaviate or something else. Nothing above it knows which, which is the only reason a deployment can change that decision later.',
        provided: ['InMemoryVectorStore'],
      },
      {
        name: 'Embedding provider',
        port: 'EmbeddingProvider',
        description:
          'Turns text into vectors. The framework ships a deterministic hashing provider for tests — usable, and not a real embedding model.',
        provided: ['HashingEmbeddingProvider'],
      },
      {
        name: 'Knowledge store',
        port: 'KnowledgeStore',
        description: 'Where collections and documents live.',
        provided: ['InMemoryKnowledgeStore'],
      },
      {
        name: 'Keyword search',
        port: 'KeywordSearch',
        description:
          'The other half of hybrid search. Wire full-text search from the database; without it, retrieval is vector-only.',
        provided: [],
      },
    ],
    outOfScope: [
      'A specific vector database',
      'A production embedding model',
      'Document parsing (PDF, DOCX, OCR)',
      'Web crawling and scheduled ingestion',
      'Cross-tenant or global knowledge bases',
    ],
  },

  // ==========================================================================
  // agent
  // ==========================================================================
  {
    metadata: {
      id: 'agent',
      name: 'Agent Framework',
      description:
        'Agents that take actions: declarative definitions, the tool loop with per-actor permission checks, memory, conversation state, stop conditions and human review.',
      version: VERSION,
      minimumFrameworkVersion: MINIMUM_FRAMEWORK,
      owner: OWNER,
      stability: 'stable',
      tags: ['ai', 'agents', 'automation'],
    },
    packaging: packaging('agent', 'AgentModule'),
    dependencies: [
      {
        moduleId: 'ai',
        versionRange: '^0.1.0',
        reason:
          'An agent is a loop around model calls, and every model call goes through the gateway.',
      },
    ],
    permissions: [
      {
        key: 'agent.definition.read',
        description: 'List the registered agents and what each may do.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'agent.definition.manage',
        description: 'Register an agent and change its tools, limits and prompt.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'agent.run',
        description:
          "Run an agent. An agent's own requiredPermissions are checked in addition to this one.",
        // Not the auditor. Running an agent spends money and can call tools, which is not a
        // read-only act however read-only the question sounds.
        suggestedRoles: ['organization_owner', 'administrator', 'operator'],
      },
      {
        key: 'agent.memory.read',
        description: 'Read what an agent remembers about a user or an organization.',
        suggestedRoles: READ_ROLES,
      },
      {
        key: 'agent.memory.forget',
        description: 'Delete a memory. Needed for a subject access request.',
        suggestedRoles: WRITE_ROLES,
      },
      {
        key: 'agent.review.decide',
        description:
          'Approve, reject or escalate AI output. Never held by the person or process that produced it.',
        suggestedRoles: WRITE_ROLES,
      },
    ],
    routes: [],
    auditEvents: [
      {
        action: 'agent.run',
        entityType: 'AiAgentRun',
        description:
          'An agent ran. Records which tools were called and why it stopped — never the conversation.',
      },
      {
        action: 'agent.tool.called',
        entityType: 'AiToolCall',
        description: 'An agent called a tool, with the outcome.',
      },
      {
        action: 'agent.tool.denied',
        entityType: 'AiToolCall',
        description:
          'A tool call was refused because the actor lacked the permission. The prompt-injection signal worth alerting on.',
      },
      {
        action: 'agent.review.requested',
        entityType: 'AiReviewRequest',
        description: 'Output was queued for a person to check.',
      },
      {
        action: 'agent.review.approve',
        entityType: 'AiReviewRequest',
        description: 'A reviewer approved AI output, possibly with a correction.',
      },
      {
        action: 'agent.review.reject',
        entityType: 'AiReviewRequest',
        description: 'A reviewer rejected AI output, with the reason.',
      },
    ],
    migrations: [],
    environment: [],
    extensionPoints: [
      {
        name: 'Tool',
        port: 'FunctionDefinition',
        description:
          'What an agent can do. Each declares a schema and the permission the actor must hold. The framework ships none, because a tool is an action in somebody else’s domain.',
        provided: [],
      },
      {
        name: 'Memory store',
        port: 'MemoryStore',
        description: 'Where agent memory lives, scoped by conversation, session, user or tenant.',
        provided: ['InMemoryMemoryStore'],
      },
      {
        name: 'Conversation store',
        port: 'ConversationStore',
        description: 'Where conversations and their turns live.',
        provided: ['InMemoryConversationStore'],
      },
      {
        name: 'Review store',
        port: 'ReviewStore',
        description: 'The human review queue.',
        provided: ['InMemoryReviewStore'],
      },
      {
        name: 'Summariser',
        port: 'summarise',
        description:
          'Compacts a long conversation. A port rather than an implementation, because summarising well needs a model call — and a conversation service that made model calls would depend on everything.',
        provided: [],
      },
    ],
    outOfScope: [
      'Business-specific agents (banking, lending, payments, merchants)',
      'A chat user interface',
      'Autonomous agents that run without a triggering actor',
      'Multi-agent negotiation and delegation',
      'Agent marketplaces',
    ],
  },
];

function loadCatalog(): ModuleCatalogEntry[] {
  const result = moduleCatalogSchema.safeParse(RAW_CATALOG);
  if (!result.success) {
    throw new ModuleRegistryError(
      'catalog_invalid',
      result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  return assertCatalogConsistency(result.data);
}

/**
 * Cross-entry checks.
 *
 * Per-entry validation cannot see collisions between modules, and collisions
 * between modules are the failure this catalog exists to prevent: two modules
 * claiming one route would be a silent Nest conflict at boot, and two modules
 * claiming one permission key would make a single role grant apply to both.
 */
export function assertCatalogConsistency(entries: ModuleCatalogEntry[]): ModuleCatalogEntry[] {
  const problems: string[] = [];
  const seen = <T>(values: T[]): T[] => {
    const once = new Set<T>();
    const twice = new Set<T>();
    for (const value of values) {
      if (once.has(value)) twice.add(value);
      once.add(value);
    }
    return [...twice];
  };

  for (const duplicate of seen(entries.map((entry) => entry.metadata.id))) {
    problems.push(`duplicate module id "${duplicate}".`);
  }
  for (const duplicate of seen(entries.flatMap((entry) => entry.permissions.map((p) => p.key)))) {
    problems.push(`permission key "${duplicate}" is claimed by more than one module.`);
  }
  for (const duplicate of seen(
    entries.flatMap((entry) => entry.routes.map((route) => `${route.method} ${route.path}`)),
  )) {
    problems.push(`route "${duplicate}" is claimed by more than one module.`);
  }
  for (const duplicate of seen(
    entries.flatMap((entry) => entry.migrations.map((migration) => migration.schemaFragment)),
  )) {
    problems.push(`schema fragment "${duplicate}" is claimed by more than one module.`);
  }
  for (const duplicate of seen(entries.flatMap((entry) => entry.environment.map((v) => v.name)))) {
    problems.push(`environment variable "${duplicate}" is claimed by more than one module.`);
  }

  const known = new Set(entries.map((entry) => entry.metadata.id));
  for (const entry of entries) {
    for (const dependency of entry.dependencies) {
      if (!known.has(dependency.moduleId)) {
        problems.push(
          `module "${entry.metadata.id}" depends on unknown module "${dependency.moduleId}".`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new ModuleRegistryError('catalog_invalid', problems.join('; '));
  }

  // A cyclic catalog has no install order and no start-up order, so it cannot
  // be loaded at all.
  assertNoCycles(entries);
  return entries;
}

/** The validated catalog. Parsed once, at import. */
export const MODULE_CATALOG: ModuleCatalogEntry[] = loadCatalog();
