import { z } from 'zod';
import type { AuditService } from '@trustsystem/audit';
import type { Environment } from '@trustsystem/governance-tool-core';

/**
 * The audit bridge.
 *
 * Governance Tool actions are audited **into the TrustOS audit trail**, not into a log of the
 * Governance Tool's own. That direction is the whole package, and it is worth being explicit
 * about why: two audit trails means two answers to "what happened", and during an investigation
 * somebody has to decide which one is right. TrustOS audit is authoritative; this bridge adds
 * what TrustOS could not have known.
 *
 * What it adds is the **provenance**: which internal application caused this, in which
 * environment, under which correlation id, for which stated reason, against which approval. A
 * TrustOS audit record says "usr_7 froze wallet wlt_3". This bridge makes it say "usr_7 froze
 * wallet wlt_3 from the customer support console, in production, because of case cas_9, having
 * requested approval apr_2, correlated to req_abc".
 *
 * The second sentence is the one an investigation can act on.
 *
 * **Nothing here is authoritative and nothing here can be edited.** The bridge writes; it has no
 * update and no delete, and neither does `AuditService`.
 */

export const governanceAuditSchema = z
  .object({
    /** The internal application. The field that makes this bridge worth having. */
    appId: z.string().min(1).max(80),
    appName: z.string().min(1).max(120),
    environment: z.enum(['dev', 'uat', 'prod']),

    action: z.string().min(3).max(120),
    resourceType: z.string().min(1).max(80),
    resourceId: z.string().min(1).max(200),

    actorId: z.string().min(1).max(80),
    actorType: z.enum(['human', 'service_account']),
    organizationId: z.string().min(1).max(80).nullable(),

    /**
     * The stated reason, where the action declared one.
     *
     * Carried verbatim. A reason paraphrased on the way into the audit trail is a reason nobody
     * can quote back, and quoting it back is what a reason is for.
     */
    reason: z.string().max(1000).nullable(),
    /** The approval this action was performed under, when it needed one. */
    approvalRef: z.string().max(120).nullable(),

    correlationId: z.string().min(1).max(120),
    requestId: z.string().max(120).nullable(),

    outcome: z.enum(['allowed', 'refused', 'failed']),
    occurredAt: z.string().datetime(),

    /**
     * Before and after, for a change.
     *
     * Bounded scalars, and **masked before they arrive**. An audit record of a change to a
     * masked field must not carry the unmasked value — otherwise the audit trail becomes the
     * easiest place in the platform to read the data the masking exists to hide.
     */
    before: z.record(z.union([z.string().max(400), z.number(), z.boolean(), z.null()])).optional(),
    after: z.record(z.union([z.string().max(400), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

export type GovernanceAuditEntry = z.infer<typeof governanceAuditSchema>;

export interface AuditBridgeOptions {
  /** The authoritative trail. Required — a bridge with an optional destination is a log. */
  audit: AuditService;
  /** The application name, for the audit record's `application` field. */
  application: string;
  environment: Environment;
}

/**
 * Forwards a Governance Tool action into the TrustOS audit trail.
 *
 * Worth knowing, because it is easy to assume the opposite: `AuditService.record` **does not
 * throw** when its sink is unavailable. It logs at error level and returns, so that a sink
 * outage degrades the trail rather than taking the platform down with it. That is phase 1's
 * decision and this bridge inherits it.
 *
 * The consequence for an operator: a missing audit record does not fail the action, and nobody
 * retries a missing record because nobody knows it is missing. The compensating control is the
 * error log and whatever alerts on it — so a deployment that cares about this alerts on
 * "audit record could not be written", which is the exact message `AuditService` emits.
 */
export class GovernanceAuditBridge {
  constructor(private readonly options: AuditBridgeOptions) {}

  async record(input: unknown): Promise<GovernanceAuditEntry> {
    const entry = governanceAuditSchema.parse(input);

    await this.options.audit.record({
      action: entry.action,
      entityType: entry.resourceType,
      entityId: entry.resourceId,
      actorId: entry.actorId,
      organizationId: entry.organizationId,
      ...(entry.before ? { before: entry.before } : {}),
      ...(entry.after ? { after: entry.after } : {}),
      metadata: {
        /*
         * The provenance. This is what TrustOS could not have known.
         */
        governanceAppId: entry.appId,
        governanceAppName: entry.appName,
        governanceEnvironment: entry.environment,
        actorType: entry.actorType,
        reason: entry.reason,
        approvalRef: entry.approvalRef,
        correlationId: entry.correlationId,
        requestId: entry.requestId,
        outcome: entry.outcome,
        occurredAt: entry.occurredAt,
      },
    });

    return entry;
  }
}

/**
 * Builds an entry from the pieces the runtime holds.
 *
 * One constructor rather than object literals at call sites, because an audit record assembled
 * differently in five places is an audit record that is missing a field in one of them — and the
 * missing field is discovered by an auditor rather than by a test.
 */
export function governanceAuditEntry(input: {
  appId: string;
  appName: string;
  environment: Environment;
  action: string;
  resourceType: string;
  resourceId: string;
  actorId: string;
  actorType: 'human' | 'service_account';
  organizationId: string | null;
  outcome: 'allowed' | 'refused' | 'failed';
  correlationId: string;
  now: Date;
  reason?: string | null;
  approvalRef?: string | null;
  requestId?: string | null;
  before?: Record<string, string | number | boolean | null>;
  after?: Record<string, string | number | boolean | null>;
}): GovernanceAuditEntry {
  return governanceAuditSchema.parse({
    appId: input.appId,
    appName: input.appName,
    environment: input.environment,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actorId: input.actorId,
    actorType: input.actorType,
    organizationId: input.organizationId,
    reason: input.reason ?? null,
    approvalRef: input.approvalRef ?? null,
    correlationId: input.correlationId,
    requestId: input.requestId ?? null,
    outcome: input.outcome,
    occurredAt: input.now.toISOString(),
    ...(input.before ? { before: input.before } : {}),
    ...(input.after ? { after: input.after } : {}),
  });
}

/**
 * The actions the Governance Tool audits.
 *
 * Specific rather than generic, for the reason every audit catalog in this framework is: an
 * auditor searching for reveals will search for `governance.pii.revealed`, and a generic
 * `governance.action` would mean reading every record and inspecting its metadata.
 */
export const GOVERNANCE_AUDIT_ACTIONS = {
  APP_OPENED: 'governance.app.opened',
  APP_CREATED: 'governance.app.created',
  APP_UPDATED: 'governance.app.updated',
  APP_SUBMITTED: 'governance.app.submitted',
  APP_APPROVED: 'governance.app.approved',
  APP_PROMOTED: 'governance.app.promoted',
  APP_RETIRED: 'governance.app.retired',

  RESOURCE_REGISTERED: 'governance.resource.registered',
  RESOURCE_APPROVED: 'governance.resource.approved',
  RESOURCE_REVOKED: 'governance.resource.revoked',

  DATA_READ: 'governance.data.read',
  DATA_READ_REFUSED: 'governance.data.read_refused',
  MUTATION_REQUESTED: 'governance.mutation.requested',
  MUTATION_REFUSED: 'governance.mutation.refused',

  PII_REVEAL_REQUESTED: 'governance.pii.reveal_requested',
  PII_REVEALED: 'governance.pii.revealed',
  PII_REVEAL_REFUSED: 'governance.pii.reveal_refused',

  EXPORT_REQUESTED: 'governance.export.requested',
  EXPORT_APPROVED: 'governance.export.approved',
  EXPORT_PRODUCED: 'governance.export.produced',
  EXPORT_REFUSED: 'governance.export.refused',

  AI_ASSIST_REQUESTED: 'governance.ai.assist_requested',
  AI_OUTPUT_REVIEWED: 'governance.ai.output_reviewed',
} as const;

export type GovernanceAuditAction =
  (typeof GOVERNANCE_AUDIT_ACTIONS)[keyof typeof GOVERNANCE_AUDIT_ACTIONS];

/** Actions that must be audited even when they were refused. */
export const AUDIT_ON_REFUSAL: readonly string[] = [
  GOVERNANCE_AUDIT_ACTIONS.DATA_READ_REFUSED,
  GOVERNANCE_AUDIT_ACTIONS.MUTATION_REFUSED,
  GOVERNANCE_AUDIT_ACTIONS.PII_REVEAL_REFUSED,
  GOVERNANCE_AUDIT_ACTIONS.EXPORT_REFUSED,
];
