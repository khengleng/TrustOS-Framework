import { randomUUID } from 'node:crypto';
import { redactSecrets } from '@trustos/security-policy';
import type { ActorType } from '@trustos/shared-types';

/**
 * Security events.
 *
 * Separate from the audit trail, and the distinction is worth stating because it
 * decides where a given record belongs.
 *
 *   The **audit trail** answers "who changed what": business actions, with
 *   before and after, attributed to an organization. It is evidence for a
 *   customer dispute or a regulator.
 *
 *   **Security events** answer "what happened to the perimeter": a failed login,
 *   a refused authorization, a reused refresh token, an API key authenticating
 *   from an address that is not on its allowlist. Most of them have no
 *   organization and no actor, because the whole point is that authentication did
 *   not succeed.
 *
 * A failed login has no audit record — nothing changed — and it is the single
 * most useful security event there is. Conflating the two loses it.
 *
 * Every event goes through `redactSecrets` before it reaches a sink, so a context
 * object assembled at a call site cannot carry a token into an event store.
 */

export const SECURITY_EVENT_TYPES = [
  // --- authentication -------------------------------------------------------
  'auth.succeeded',
  'auth.failed',
  'auth.mfa_required',
  'auth.mfa_failed',
  'auth.assurance_insufficient',
  'auth.account_locked',
  'auth.account_lockout_cleared',
  'auth.password_changed',
  'auth.password_rejected_compromised',
  'auth.user_enumeration_attempt',
  'auth.provider_rejected_token',

  // --- sessions -------------------------------------------------------------
  'session.created',
  'session.revoked',
  'session.all_revoked',
  'session.idle_timeout',
  'session.absolute_timeout',
  'session.concurrency_evicted',
  'session.refresh_rotated',
  'session.refresh_reuse_detected',
  'session.suspicious',

  // --- credentials ----------------------------------------------------------
  'api_key.created',
  'api_key.rotated',
  'api_key.revoked',
  'api_key.auth_failed',
  'api_key.auth_succeeded',
  'api_key.scope_denied',
  'api_key.ip_denied',
  'api_key.expired',
  'service_account.created',
  'service_account.used',
  'service_account.disabled',
  'service_account.interactive_login_blocked',

  // --- authorization --------------------------------------------------------
  'authz.denied',
  'authz.cross_tenant_blocked',
  'authz.role_escalation_blocked',
  'authz.inactive_member_blocked',
  'authz.role_changed',
  'authz.permission_changed',

  // --- abuse and integrity --------------------------------------------------
  'abuse.rate_limited',
  'abuse.csrf_rejected',
  'abuse.cors_rejected',
  'abuse.suspicious_activity',

  // --- identity provider ----------------------------------------------------
  'identity.provider_unavailable',
  'identity.jwks_refreshed',
  'identity.configuration_rejected',
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export type SecurityEventResult = 'success' | 'failure' | 'blocked';

/**
 * Severity, so a sink can route without parsing the type.
 *
 * `critical` is reserved for events that mean an active compromise is likely —
 * a reused refresh token, a blocked cross-tenant access — rather than for
 * anything merely unwanted.
 */
export type SecuritySeverity = 'info' | 'warning' | 'critical';

export const SEVERITY_BY_TYPE: Partial<Record<SecurityEventType, SecuritySeverity>> = {
  'session.refresh_reuse_detected': 'critical',
  'authz.cross_tenant_blocked': 'critical',
  'authz.role_escalation_blocked': 'critical',
  'abuse.suspicious_activity': 'critical',
  'session.suspicious': 'critical',
  'api_key.ip_denied': 'warning',
  'api_key.auth_failed': 'warning',
  'api_key.scope_denied': 'warning',
  'auth.failed': 'warning',
  'auth.account_locked': 'warning',
  'auth.mfa_failed': 'warning',
  'auth.assurance_insufficient': 'warning',
  'auth.user_enumeration_attempt': 'warning',
  'auth.provider_rejected_token': 'warning',
  'abuse.rate_limited': 'warning',
  'abuse.csrf_rejected': 'warning',
  'abuse.cors_rejected': 'warning',
  'authz.denied': 'warning',
  'identity.provider_unavailable': 'critical',
  'identity.configuration_rejected': 'critical',
  'service_account.interactive_login_blocked': 'warning',
};

export function severityOf(type: SecurityEventType): SecuritySeverity {
  return SEVERITY_BY_TYPE[type] ?? 'info';
}

/** Risk signals, when something upstream provides them. */
export interface RiskMetadata {
  /** 0..100. Absent when nothing computed one. */
  score?: number;
  /** Named signals, e.g. ['new_device', 'impossible_travel']. */
  signals?: string[];
  /** Whether the source of the request is known to the system. */
  knownDevice?: boolean;
}

/** What a call site supplies. Everything not given is filled in or left null. */
export interface SecurityEventInput {
  type: SecurityEventType;
  result: SecurityEventResult;
  /** Machine-readable reason, e.g. `token_expired`. Never a stack trace. */
  reason?: string | null;

  actorId?: string | null;
  actorType?: ActorType | null;
  organizationId?: string | null;

  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;

  /** Which application produced the event. */
  application?: string | null;
  /** Identity provider involved, when one was. */
  provider?: string | null;

  risk?: RiskMetadata;
  /** Non-sensitive detail. Redacted before it reaches a sink. */
  context?: Record<string, unknown>;

  occurredAt?: Date;
  severity?: SecuritySeverity;
}

/** A complete event, as handed to a sink. */
export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  severity: SecuritySeverity;
  result: SecurityEventResult;
  reason: string | null;

  actorId: string | null;
  actorType: ActorType | null;
  organizationId: string | null;

  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;

  application: string | null;
  provider: string | null;

  risk: RiskMetadata | null;
  context: Record<string, unknown> | null;

  occurredAt: Date;
}

/**
 * Where events go.
 *
 * `emit` must not throw. A sink that fails has to be a logged problem, never a
 * failed request: an authentication that succeeds and then 500s because the event
 * store was unreachable is worse than one that succeeds unrecorded — and the
 * emitter, not the sink, is where that guarantee is enforced.
 */
export interface SecurityEventSink {
  readonly id: string;
  emit(event: SecurityEvent): Promise<void> | void;
}

/** Collects events in memory. Used by tests and by the security portal's demo. */
export class InMemorySecurityEventSink implements SecurityEventSink {
  readonly id = 'memory';
  readonly events: SecurityEvent[] = [];

  constructor(private readonly capacity = 1000) {}

  emit(event: SecurityEvent): void {
    this.events.push(event);
    // Bounded: an in-memory sink that grows without limit is a slow leak in a
    // long-running process, and the oldest events are the least useful.
    if (this.events.length > this.capacity) this.events.shift();
  }

  byType(type: SecurityEventType): SecurityEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  /** Most recent first, which is the order an operator wants to read. */
  recent(limit = 50): SecurityEvent[] {
    return [...this.events].reverse().slice(0, limit);
  }

  serialized(): string {
    return JSON.stringify(this.events);
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** What the emitter needs from a logger. Narrow, so a fake is two lines. */
export interface SecurityEventLogger {
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
}

export interface SecurityEventEmitterOptions {
  sinks: SecurityEventSink[];
  logger?: SecurityEventLogger;
  /** Application name stamped on every event. */
  application?: string;
  /** Injectable clock, so event ordering is assertable. */
  now?: () => Date;
  /** Injectable id, so an event id is assertable. */
  newId?: () => string;
}

/**
 * Builds and dispatches events.
 *
 * The two guarantees:
 *
 *   1. **A sink failure never propagates.** Every sink is called, failures are
 *      logged, and the caller's promise resolves. Security recording must not be
 *      able to fail a request it was only observing.
 *   2. **Context is redacted before dispatch.** Not in each sink, where one
 *      forgetting would be enough.
 */
export class SecurityEventEmitter {
  private readonly sinks: SecurityEventSink[];
  private readonly logger: SecurityEventLogger | undefined;
  private readonly application: string | null;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: SecurityEventEmitterOptions) {
    this.sinks = options.sinks;
    this.logger = options.logger;
    this.application = options.application ?? null;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  build(input: SecurityEventInput): SecurityEvent {
    return {
      id: this.newId(),
      type: input.type,
      severity: input.severity ?? severityOf(input.type),
      result: input.result,
      reason: input.reason ?? null,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? null,
      organizationId: input.organizationId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      application: input.application ?? this.application,
      provider: input.provider ?? null,
      risk: input.risk ?? null,
      context: input.context ? (redactSecrets(input.context) as Record<string, unknown>) : null,
      occurredAt: input.occurredAt ?? this.now(),
    };
  }

  async emit(input: SecurityEventInput): Promise<SecurityEvent> {
    const event = this.build(input);

    for (const sink of this.sinks) {
      try {
        await sink.emit(event);
      } catch (error) {
        this.logger?.error(
          {
            sink: sink.id,
            eventType: event.type,
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'security event sink failed',
        );
      }
    }

    // Critical events are also logged directly. A sink can be misconfigured; the
    // application log is the one place an operator is definitely already looking.
    if (event.severity === 'critical') {
      this.logger?.error(logPayload(event), `security: ${event.type}`);
    } else if (event.severity === 'warning') {
      this.logger?.warn(logPayload(event), `security: ${event.type}`);
    }

    return event;
  }
}

function logPayload(event: SecurityEvent): Record<string, unknown> {
  return {
    securityEventId: event.id,
    eventType: event.type,
    result: event.result,
    reason: event.reason,
    actorId: event.actorId,
    actorType: event.actorType,
    organizationId: event.organizationId,
    requestId: event.requestId,
    ipAddress: event.ipAddress,
    provider: event.provider,
  };
}

/** An emitter that discards everything. For a test that is not about events. */
export function createNullSecurityEventEmitter(): SecurityEventEmitter {
  return new SecurityEventEmitter({ sinks: [] });
}
