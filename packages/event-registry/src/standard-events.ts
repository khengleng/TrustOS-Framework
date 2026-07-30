import { z } from 'zod';
import type { EventSchemaDefinition } from './registry';

/**
 * The events the framework itself publishes.
 *
 * Every one describes something the framework already does — a user was created, a workflow
 * instance completed, a document was uploaded. None of them is a business event: there is no
 * `payment.settled` here and there will not be, because that belongs to whatever product is built
 * on this.
 *
 * Two rules shaped every payload below, and both are worth stating because they are easy to
 * violate one field at a time:
 *
 *   * **Identifiers, not entities.** `user.created` carries a user id, not the user. An event is
 *     a durable record copied into queues, webhook bodies and dead-letter rows; embedding an
 *     entity means embedding whatever that entity contains today *and* whatever somebody adds to
 *     it next quarter. The email address in `user.created` is the exception, and it is there
 *     because a welcome-email consumer that had to call back for it would be the reason everybody
 *     stops using events.
 *   * **Nothing secret, ever.** No password hash, no token, no secret value, not even a
 *     truncated one. `event-sdk`'s redactor is a safety net, not the control.
 */

const organizationScope = {
  organizationId: z.string().min(1).max(64).nullable(),
};

/** Identity. Enough for a consumer to act; never enough to impersonate. */
export const IDENTITY_EVENTS: EventSchemaDefinition[] = [
  {
    name: 'identity.user.created',
    version: '1',
    description: 'A user account was created.',
    aggregateType: 'User',
    payload: z
      .object({
        userId: z.string().min(1).max(64),
        email: z.string().email(),
        displayName: z.string().max(200).nullable(),
        // How the account came into being. A consumer sending a welcome email needs to know
        // whether the person chose a password or arrived through single sign-on, because the two
        // emails say different things.
        provisionedBy: z.enum(['self_service', 'invitation', 'admin', 'directory_sync']),
        ...organizationScope,
      })
      .strict(),
    example: {
      userId: 'usr_01HZ',
      email: 'dara@example.com',
      displayName: 'Dara Sok',
      provisionedBy: 'invitation',
      organizationId: 'org_01HZ',
    },
  },
  {
    name: 'identity.user.deactivated',
    version: '1',
    description: 'A user account was deactivated. Sessions and tokens are already revoked.',
    aggregateType: 'User',
    payload: z
      .object({
        userId: z.string().min(1).max(64),
        reason: z.string().max(500).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'identity.user.role_granted',
    version: '1',
    description: 'A role was granted to a user.',
    aggregateType: 'User',
    payload: z
      .object({
        userId: z.string().min(1).max(64),
        roleKey: z.string().max(120),
        grantedById: z.string().min(1).max(64).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'identity.user.role_revoked',
    version: '1',
    description: 'A role was revoked from a user.',
    aggregateType: 'User',
    payload: z
      .object({
        userId: z.string().min(1).max(64),
        roleKey: z.string().max(120),
        revokedById: z.string().min(1).max(64).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'identity.session.revoked',
    version: '1',
    description: 'A session was revoked, by the user or by an administrator.',
    aggregateType: 'Session',
    payload: z
      .object({
        // The session id, not the token. The token is a credential and never appears in an event.
        sessionId: z.string().min(1).max(64),
        userId: z.string().min(1).max(64),
        revokedBy: z.enum(['self', 'administrator', 'system', 'reuse_detected']),
        ...organizationScope,
      })
      .strict(),
  },
];

/** Tenancy. */
export const ORGANIZATION_EVENTS: EventSchemaDefinition[] = [
  {
    name: 'organization.created',
    version: '1',
    description: 'An organization was created.',
    aggregateType: 'Organization',
    payload: z
      .object({
        organizationId: z.string().min(1).max(64),
        slug: z.string().max(120),
        name: z.string().max(200),
      })
      .strict(),
  },
  {
    name: 'organization.suspended',
    version: '1',
    description: 'An organization was suspended. Its users can no longer sign in.',
    aggregateType: 'Organization',
    payload: z
      .object({
        organizationId: z.string().min(1).max(64),
        reason: z.string().max(500).nullable(),
      })
      .strict(),
  },
];

/**
 * Workflow. The phase 5 engine publishes these.
 *
 * `workflow.instance.state_changed` carries both states rather than only the new one, because a
 * consumer that only knows where an instance arrived cannot tell an approval from a rework
 * without querying — and the whole point is not having to.
 */
export const WORKFLOW_EVENTS: EventSchemaDefinition[] = [
  {
    name: 'workflow.instance.started',
    version: '1',
    description: 'A workflow instance was started.',
    aggregateType: 'WorkflowInstance',
    payload: z
      .object({
        instanceId: z.string().min(1).max(64),
        definitionKey: z.string().max(120),
        definitionVersion: z.string().max(40),
        initialState: z.string().max(120),
        subjectType: z.string().max(120).nullable(),
        subjectId: z.string().max(64).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'workflow.instance.state_changed',
    version: '1',
    description: 'A workflow instance moved from one state to another.',
    aggregateType: 'WorkflowInstance',
    payload: z
      .object({
        instanceId: z.string().min(1).max(64),
        fromState: z.string().max(120),
        toState: z.string().max(120),
        transitionKey: z.string().max(120),
        isRework: z.boolean(),
        isCancellation: z.boolean(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'workflow.instance.completed',
    version: '1',
    description: 'A workflow instance reached a final state.',
    aggregateType: 'WorkflowInstance',
    payload: z
      .object({
        instanceId: z.string().min(1).max(64),
        finalState: z.string().max(120),
        outcome: z.enum(['approved', 'rejected', 'cancelled', 'completed']),
        durationMs: z.number().int().min(0),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'workflow.task.assigned',
    version: '1',
    description: 'A task was assigned to a user or to a role.',
    aggregateType: 'WorkflowTask',
    payload: z
      .object({
        taskId: z.string().min(1).max(64),
        instanceId: z.string().min(1).max(64),
        assigneeId: z.string().max(64).nullable(),
        assigneeRole: z.string().max(120).nullable(),
        dueAt: z.string().datetime().nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'workflow.task.completed',
    version: '1',
    description: 'A task was completed.',
    aggregateType: 'WorkflowTask',
    payload: z
      .object({
        taskId: z.string().min(1).max(64),
        instanceId: z.string().min(1).max(64),
        completedById: z.string().min(1).max(64),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'workflow.approval.decided',
    version: '1',
    description: 'An approver recorded a decision.',
    aggregateType: 'WorkflowInstance',
    payload: z
      .object({
        instanceId: z.string().min(1).max(64),
        decisionId: z.string().min(1).max(64),
        decision: z.enum(['approved', 'rejected', 'returned']),
        approverId: z.string().min(1).max(64),
        // Whether this decision satisfied the step. A consumer notifying a requester wants the
        // one that finished it, not each individual approval in a four-of-five step.
        stepSatisfied: z.boolean(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'workflow.sla.breached',
    version: '1',
    description: 'A task or instance passed its SLA deadline.',
    aggregateType: 'WorkflowInstance',
    payload: z
      .object({
        instanceId: z.string().min(1).max(64),
        taskId: z.string().max(64).nullable(),
        dueAt: z.string().datetime(),
        breachedByMs: z.number().int().min(0),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'workflow.escalation.raised',
    version: '1',
    description: 'An escalation was raised against a task or an instance.',
    aggregateType: 'WorkflowInstance',
    payload: z
      .object({
        escalationId: z.string().min(1).max(64),
        instanceId: z.string().min(1).max(64),
        taskId: z.string().max(64).nullable(),
        level: z.number().int().min(1).max(10),
        ruleKey: z.string().max(120),
        ...organizationScope,
      })
      .strict(),
  },
];

/** Documents. */
export const DOCUMENT_EVENTS: EventSchemaDefinition[] = [
  {
    name: 'document.uploaded',
    version: '1',
    description: 'A document was uploaded.',
    aggregateType: 'Document',
    payload: z
      .object({
        documentId: z.string().min(1).max(64),
        // Metadata, never a URL. A storage URL in an event is a credential with an expiry
        // somebody will eventually copy into a log.
        fileName: z.string().max(400),
        contentType: z.string().max(200),
        sizeBytes: z.number().int().min(0),
        checksum: z.string().max(128).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'document.deleted',
    version: '1',
    description: 'A document was deleted.',
    aggregateType: 'Document',
    payload: z
      .object({
        documentId: z.string().min(1).max(64),
        deletedById: z.string().min(1).max(64).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
];

/**
 * The integration layer's own events.
 *
 * A webhook that has been failing for six hours is an operational fact somebody needs, and the
 * mechanism for telling them already exists — so the integration layer uses its own bus rather
 * than inventing a second notification path.
 */
export const INTEGRATION_EVENTS: EventSchemaDefinition[] = [
  {
    name: 'integration.webhook.delivery_failed',
    version: '1',
    description: 'A webhook delivery exhausted its retries and was dead-lettered.',
    aggregateType: 'WebhookEndpoint',
    payload: z
      .object({
        endpointId: z.string().min(1).max(64),
        deliveryId: z.string().min(1).max(64),
        eventName: z.string().max(120),
        attempts: z.number().int().min(1),
        lastStatusCode: z.number().int().nullable(),
        lastError: z.string().max(1000).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'integration.webhook.endpoint_disabled',
    version: '1',
    description: 'An endpoint was disabled automatically after sustained failure.',
    aggregateType: 'WebhookEndpoint',
    payload: z
      .object({
        endpointId: z.string().min(1).max(64),
        consecutiveFailures: z.number().int().min(1),
        reason: z.string().max(500),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'integration.job.failed',
    version: '1',
    description: 'A background job exhausted its retries.',
    aggregateType: 'Job',
    payload: z
      .object({
        jobId: z.string().min(1).max(64),
        jobType: z.string().max(120),
        attempts: z.number().int().min(1),
        error: z.string().max(1000),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'integration.sync.completed',
    version: '1',
    description: 'A synchronization run finished.',
    aggregateType: 'SyncConnection',
    payload: z
      .object({
        connectionId: z.string().min(1).max(64),
        runId: z.string().min(1).max(64),
        direction: z.enum(['pull', 'push', 'bidirectional']),
        recordsProcessed: z.number().int().min(0),
        recordsFailed: z.number().int().min(0),
        conflicts: z.number().int().min(0),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'integration.provider.health_changed',
    version: '1',
    description: 'A provider adapter changed health status.',
    aggregateType: 'Provider',
    payload: z
      .object({
        providerKey: z.string().max(120),
        from: z.enum(['healthy', 'warning', 'critical', 'unknown']),
        to: z.enum(['healthy', 'warning', 'critical', 'unknown']),
        detail: z.string().max(1000).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'integration.import.completed',
    version: '1',
    description: 'An import run finished.',
    aggregateType: 'ImportRun',
    payload: z
      .object({
        importId: z.string().min(1).max(64),
        format: z.string().max(40),
        rowsRead: z.number().int().min(0),
        rowsAccepted: z.number().int().min(0),
        rowsRejected: z.number().int().min(0),
        dryRun: z.boolean(),
        ...organizationScope,
      })
      .strict(),
  },
  {
    name: 'integration.export.completed',
    version: '1',
    description: 'An export run finished and its artefact is available.',
    aggregateType: 'ExportRun',
    payload: z
      .object({
        exportId: z.string().min(1).max(64),
        format: z.string().max(40),
        rowCount: z.number().int().min(0),
        // The document id, so the consumer fetches through the document module and its access
        // control rather than through a link in an event.
        documentId: z.string().max(64).nullable(),
        ...organizationScope,
      })
      .strict(),
  },
];

/**
 * Every framework event.
 *
 * A generated application registers these and adds its own. Passed to `EventRegistry` at
 * start-up — see `docs/events.md`.
 */
export const STANDARD_EVENTS: EventSchemaDefinition[] = [
  ...IDENTITY_EVENTS,
  ...ORGANIZATION_EVENTS,
  ...WORKFLOW_EVENTS,
  ...DOCUMENT_EVENTS,
  ...INTEGRATION_EVENTS,
];

/** The standard event names, for a subscription UI or a CLI listing. */
export const STANDARD_EVENT_NAMES = STANDARD_EVENTS.map((event) => event.name);
