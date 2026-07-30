import type { SecurityEvent, SecurityEventSink } from './events';

/**
 * Sinks that bridge security events into things the framework already has.
 *
 * Both are written against narrow ports rather than against `@trustos/audit` or
 * `@trustos/logging` directly, so this package stays installable without pulling
 * a Prisma client into a worker that only needs to record a failed login.
 */

/** What the audit bridge needs. `AuditService` satisfies it; a test asserts so. */
export interface AuditPort {
  record(input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    actorId?: string | null;
    organizationId?: string | null;
    before?: unknown;
    after?: unknown;
  }): Promise<void>;
}

/**
 * Writes security events into the audit trail.
 *
 * Only events that have an organization, and only those that represent something
 * an organization's own administrators should be able to see. A failed login for
 * an unknown email has no organization and belongs nowhere near a customer's
 * audit log; a revoked API key belongs squarely in it.
 *
 * The filter is an allow-list rather than a deny-list, because the failure mode of
 * getting it wrong is putting perimeter noise — or another tenant's failed
 * attempts — into a customer-visible trail.
 */
export const AUDITABLE_SECURITY_EVENTS = new Set<string>([
  'api_key.created',
  'api_key.rotated',
  'api_key.revoked',
  'service_account.created',
  'service_account.disabled',
  'session.revoked',
  'session.all_revoked',
  'authz.role_changed',
  'authz.permission_changed',

  /*
   * A blocked self-approval belongs in the customer's trail: it is a governance fact
   * about their own workflow, and an auditor asking "was maker-checker enforced" is
   * asking exactly this. So do the two privileged operations that steer a decision.
   *
   * `workflow.definition_tampering_detected` deliberately does *not* cross over. It
   * means the platform's own database was written to outside the application, which
   * is the platform operator's problem and not the tenant's.
   */
  'workflow.self_approval_blocked',
  'workflow.separation_of_duty_blocked',
  'workflow.task_reassigned',
  'workflow.approval_overridden',
]);

export class AuditSecurityEventSink implements SecurityEventSink {
  readonly id = 'audit';

  constructor(private readonly audit: AuditPort) {}

  async emit(event: SecurityEvent): Promise<void> {
    if (!event.organizationId) return;
    if (!AUDITABLE_SECURITY_EVENTS.has(event.type)) return;

    await this.audit.record({
      // Prefixed so a reader can tell an audit record that originated as a
      // security event from one written by business code.
      action: `security.${event.type}`,
      entityType: 'SecurityEvent',
      entityId: event.id,
      actorId: event.actorId,
      organizationId: event.organizationId,
      // `context` has already been redacted by the emitter.
      after: { result: event.result, reason: event.reason, ...(event.context ?? {}) },
    });
  }
}

/** What the logging sink needs. `Logger` from @trustos/logging satisfies it. */
export interface StructuredLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

/**
 * Writes every event to the application log.
 *
 * Useful on its own: a deployment with no security event store still gets a
 * queryable record, because the log is already shipped somewhere.
 */
export class LoggerSecurityEventSink implements SecurityEventSink {
  readonly id = 'logger';

  constructor(private readonly logger: StructuredLogger) {}

  emit(event: SecurityEvent): void {
    const payload = {
      securityEventId: event.id,
      eventType: event.type,
      severity: event.severity,
      result: event.result,
      reason: event.reason,
      actorId: event.actorId,
      actorType: event.actorType,
      organizationId: event.organizationId,
      requestId: event.requestId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      application: event.application,
      provider: event.provider,
      risk: event.risk,
      context: event.context,
      occurredAt: event.occurredAt.toISOString(),
    };

    if (event.severity === 'critical') this.logger.error(payload, `security: ${event.type}`);
    else if (event.severity === 'warning') this.logger.warn(payload, `security: ${event.type}`);
    else this.logger.info(payload, `security: ${event.type}`);
  }
}

/** Row shape for a persistent store. Mirrors the SecurityEvent model. */
export interface SecurityEventRow {
  id: string;
  type: string;
  severity: string;
  result: string;
  reason: string | null;
  actorId: string | null;
  actorType: string | null;
  organizationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  application: string | null;
  provider: string | null;
  risk: unknown;
  context: unknown;
  occurredAt: Date;
}

/** What a Prisma delegate needs to expose for the persistent sink. */
export interface SecurityEventDelegate {
  /*
   * `Record<string, unknown>` rather than `SecurityEventRow`, matching the other
   * Prisma ports in the framework. A generated client's `create` is generic over its
   * own input types, and `risk` is a Json column whose generated type is not
   * structurally assignable from `unknown` — so naming the row here would make the
   * port unusable with the very client it exists to accept. `SecurityEventRow`
   * documents the columns and is what the sink actually builds.
   */
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Persists events.
 *
 * Deliberately not tenant-scoped through `@trustos/tenancy`: most security events
 * have no organization, and a scoped delegate would refuse to write them. The
 * table is platform-owned. Reading it is gated separately: the security portal's
 * event list requires `security.event.read` *and* filters on the caller's own
 * organization, so a tenant never sees an event that belongs to the platform or to
 * somebody else — see apps/security-admin-example.
 */
export class PersistentSecurityEventSink implements SecurityEventSink {
  readonly id = 'database';

  constructor(private readonly delegate: SecurityEventDelegate) {}

  async emit(event: SecurityEvent): Promise<void> {
    // Built as a `SecurityEventRow` first, so the column list is type-checked even
    // though the delegate accepts a looser shape.
    const row: SecurityEventRow = {
      id: event.id,
      type: event.type,
      severity: event.severity,
      result: event.result,
      reason: event.reason,
      actorId: event.actorId,
      actorType: event.actorType,
      organizationId: event.organizationId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      requestId: event.requestId,
      application: event.application,
      provider: event.provider,
      risk: event.risk,
      context: event.context,
      occurredAt: event.occurredAt,
    };

    await this.delegate.create({ data: row as unknown as Record<string, unknown> });
  }
}
