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
